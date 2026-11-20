import hmac
import logging
import os
import typing as t
from datetime import datetime

from django.core import exceptions as django_exceptions
from django.core.files.storage import default_storage
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import Count
from django.utils import timezone
from fastapi import APIRouter, Depends, Header, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from etebase_server.django import app_settings, models
from etebase_server.django.signals import user_signed_up
from etebase_server.django.token_auth.models import AuthToken
from etebase_server.fastapi.db_hack import django_db_cleanup_decorator
from etebase_server.fastapi.routers.authentication import LoginOut, SignupIn
from etebase_server.fastapi.utils import b64decode, b64encode, msgpack_decode, msgpack_encode
from etebase_server.internal.quota import bytes_used
from etebase_server.myauth.models import UserType, get_typed_user_model

User = get_typed_user_model()
logger = logging.getLogger(__name__)


class InternalApiError(Exception):
    def __init__(self, code: str, detail: str, status_code: int = status.HTTP_400_BAD_REQUEST, errors=None):
        self.code = code
        self.detail = detail
        self.status_code = status_code
        self.errors = errors


def internal_api_error_handler(request: Request, exc: InternalApiError) -> JSONResponse:
    content: t.Dict[str, t.Any] = {"code": exc.code, "detail": exc.detail}
    if exc.errors:
        content["errors"] = exc.errors
    return JSONResponse(status_code=exc.status_code, content=content)


def check_secret(authorization: str = Header(default="")):
    scheme, _, secret = authorization.partition(" ")
    secrets = app_settings.INTERNAL_API_SECRETS
    # Compare with every secret, so the time taken doesn't tell which one nearly matched
    matches = [hmac.compare_digest(secret.encode(), x.encode()) for x in secrets]
    if scheme != "Internal" or not any(matches):
        raise InternalApiError("unauthorized", "Missing or wrong internal API secret.", status.HTTP_401_UNAUTHORIZED)


internal_router = APIRouter(dependencies=[Depends(check_secret)])


class UserOut(BaseModel):
    user_id: int
    username: str
    email: str
    is_active: bool

    @classmethod
    def from_user(cls, user: UserType) -> "UserOut":
        return cls(user_id=user.id, username=user.username, email=user.email, is_active=user.is_active)


def username_problem(username: str) -> t.Optional[str]:
    """Why the username can't be used for a new account, or None"""
    # Logging in with a name that has an "@" looks the user up by email, so such a name could never log in
    if "@" in username:
        return "invalid"
    try:
        User._meta.get_field(User.USERNAME_FIELD).run_validators(username)
    except django_exceptions.ValidationError:
        return "invalid"
    if User.objects.filter(**{User.USERNAME_FIELD + "__iexact": username}).exists():
        return "taken"
    return None


def email_taken(email: str) -> bool:
    return User.objects.filter(**{User.EMAIL_FIELD + "__iexact": email}).exists()


def get_user(user_id: int) -> UserType:
    try:
        return User.objects.get(id=user_id)
    except User.DoesNotExist:
        raise InternalApiError("user_not_found", "User not found.", status.HTTP_404_NOT_FOUND)


class TokenIn(BaseModel):
    token: str


class WhoamiOut(UserOut):
    # When the token was made; making one needs the password (or the keys derived from it), so an account
    # service can ask for a recent one before changes like deleting the account
    token_created: datetime


@internal_router.post("/whoami/", response_model=WhoamiOut)
@django_db_cleanup_decorator
def whoami(data: TokenIn):
    """Who an Etebase login token belongs to, with the same checks as the API, without renewing the token"""
    invalid = InternalApiError("invalid_token", "Invalid token.", status.HTTP_401_UNAUTHORIZED)
    try:
        token = AuthToken.objects.select_related("user").get(key=data.token)
    except AuthToken.DoesNotExist:
        raise invalid
    if not token.user.is_active or (token.expiry is not None and token.expiry < timezone.now()):
        raise invalid
    return WhoamiOut(**UserOut.from_user(token.user).model_dump(), token_created=token.created)


@internal_router.get("/username-available/")
@django_db_cleanup_decorator
def username_available(username: str):
    problem = username_problem(username)
    if problem is None:
        return {"available": True}
    return {"available": False, "reason": problem}


@internal_router.get("/users/by-username/{username}/", response_model=UserOut)
@django_db_cleanup_decorator
def user_by_username(username: str):
    try:
        user = User.objects.get(**{User.USERNAME_FIELD + "__iexact": username})
    except User.DoesNotExist:
        raise InternalApiError("user_not_found", "User not found.", status.HTTP_404_NOT_FOUND)
    return UserOut.from_user(user)


class LimitsIn(BaseModel):
    bytes_limit: t.Optional[int] = Field(default=None, ge=0)
    read_only: bool = False


class InternalSignupIn(BaseModel):
    # The body of the client's signup request (msgpack), base64url
    signup: str
    # The address the account service verified; the signup must use it
    expected_email: str
    # Limits to give the new user, in the same transaction
    limits: t.Optional[LimitsIn] = None


class InternalSignupOut(BaseModel):
    user_id: int
    username: str
    # The response to give to the client as it is: msgpack, base64url
    login: str


@internal_router.post("/signup/", response_model=InternalSignupOut, status_code=status.HTTP_201_CREATED)
@django_db_cleanup_decorator
def signup(data: InternalSignupIn):
    """Creates a user from a client's signup request, which the public signup endpoint refuses"""
    try:
        signup_data = SignupIn(**msgpack_decode(b64decode(data.signup)))
    except Exception:
        raise InternalApiError("bad_signup", "The signup request could not be read.")

    username = signup_data.user.username
    email = signup_data.user.email
    if email.lower() != data.expected_email.lower():
        raise InternalApiError(
            "email_mismatch", "The signup is for another email address.", status.HTTP_422_UNPROCESSABLE_ENTITY
        )
    problem = username_problem(username)
    if problem == "taken":
        raise InternalApiError("user_exists", "User already exists.", status.HTTP_409_CONFLICT)
    if problem is not None:
        raise InternalApiError("invalid_username", "This username can't be used.")
    if email_taken(email):
        raise InternalApiError("email_taken", "Another user has this email address.", status.HTTP_409_CONFLICT)

    try:
        with transaction.atomic():
            # The casing the user chose is kept as the first name, like the public signup does
            user = User.objects.create_user(username=username, email=email, password=None, first_name=username)
            user.full_clean()
            models.UserInfo.objects.create(**signup_data.model_dump(exclude={"user"}), owner=user)
            if data.limits is not None:
                models.UserLimits.objects.create(owner=user, **data.limits.model_dump())
    except django_exceptions.ValidationError as e:
        raise InternalApiError("invalid_user", "Field validations failed.", errors=e.message_dict)
    except IntegrityError:
        # Another signup with the same name won the race
        raise InternalApiError("user_exists", "User already exists.", status.HTTP_409_CONFLICT)

    login = LoginOut.from_orm(user)
    user_signed_up.send(sender=user.__class__, request=None, user=user)
    return InternalSignupOut(user_id=user.id, username=user.username, login=b64encode(msgpack_encode(login.model_dump())))


class UsageOut(BaseModel):
    bytes_used: int
    bytes_limit: t.Optional[int]
    read_only: bool
    collections: int
    collections_shared: int
    items: int
    last_login: t.Optional[datetime]


@internal_router.get("/users/{user_id}/usage/", response_model=UsageOut)
@django_db_cleanup_decorator
def usage(user_id: int):
    user = get_user(user_id)
    limits = models.UserLimits.objects.filter(owner=user).first()
    owned = models.Collection.objects.filter(owner=user)
    # Each collection's own data is an item too (its main item), which isn't counted
    items = models.CollectionItem.objects.filter(
        collection__owner=user, parent__isnull=True, revisions__current=True, revisions__deleted=False
    )
    return UsageOut(
        bytes_used=bytes_used(user.id),
        bytes_limit=limits.bytes_limit if limits else None,
        read_only=limits.read_only if limits else False,
        collections=owned.count(),
        collections_shared=owned.annotate(member_count=Count("members")).filter(member_count__gt=1).count(),
        items=items.count(),
        last_login=user.last_login,
    )


@internal_router.put("/users/{user_id}/limits/", status_code=status.HTTP_204_NO_CONTENT)
@django_db_cleanup_decorator
def set_limits(user_id: int, data: LimitsIn):
    user = get_user(user_id)
    models.UserLimits.objects.update_or_create(owner=user, defaults=data.model_dump())


class EmailIn(BaseModel):
    email: str


@internal_router.put("/users/{user_id}/email/", status_code=status.HTTP_204_NO_CONTENT)
@django_db_cleanup_decorator
def set_email(user_id: int, data: EmailIn):
    """Changes the address the user logs in with and is invited by; the account service verified it"""
    user = get_user(user_id)
    try:
        validate_email(data.email)
    except django_exceptions.ValidationError:
        raise InternalApiError("invalid_email", "Not a valid email address.")
    if user.email.lower() == data.email.lower():
        return
    if email_taken(data.email):
        raise InternalApiError("email_taken", "Another user has this email address.", status.HTTP_409_CONFLICT)
    user.email = data.email
    user.save(update_fields=["email"])


def set_active(user: UserType, active: bool):
    user.is_active = active
    user.save(update_fields=["is_active"])


@internal_router.post("/users/{user_id}/suspend/", status_code=status.HTTP_204_NO_CONTENT)
@django_db_cleanup_decorator
def suspend(user_id: int):
    """Stops the user's every login at once (the API refuses inactive users), e.g. before deleting or for abuse"""
    set_active(get_user(user_id), False)


@internal_router.post("/users/{user_id}/unsuspend/", status_code=status.HTTP_204_NO_CONTENT)
@django_db_cleanup_decorator
def unsuspend(user_id: int):
    set_active(get_user(user_id), True)


def delete_chunk_files(names: t.List[str]):
    """Removes the files, then the folders they leave empty"""
    folders = set()
    for name in names:
        try:
            default_storage.delete(name)
        except OSError:
            logger.warning("Could not delete the chunk file %s", name)
        folders.add(os.path.dirname(name))
    # Deepest first, so a folder's subfolders are gone before it is tried
    for folder in sorted(folders, key=len, reverse=True):
        while folder:
            try:
                os.rmdir(default_storage.path(folder))
            except OSError:
                # Not empty (or already gone): the folders above it aren't empty either
                break
            folder = os.path.dirname(folder)


@internal_router.delete("/users/{user_id}/", status_code=status.HTTP_204_NO_CONTENT)
@django_db_cleanup_decorator
def delete_user(user_id: int):
    """Deletes the user with everything they own, their files too. Deleting a deleted user does nothing."""
    user = User.objects.filter(id=user_id).first()
    if user is None:
        return
    # First stop every login, so nothing is written while the user is being deleted
    set_active(user, False)
    with transaction.atomic():
        names = list(
            models.CollectionItemChunk.objects.filter(collection__owner=user).values_list("chunkFile", flat=True)
        )
        # Memberships first: they protect the user's collection types, which Django would otherwise refuse to
        # delete along with the user. Then the collections the user owns, with their items, chunks and other
        # members, and then the user with their logins, invitations and limits.
        models.CollectionMember.objects.filter(user=user).delete()
        models.Collection.objects.filter(owner=user).delete()
        user.delete()
    delete_chunk_files(names)
