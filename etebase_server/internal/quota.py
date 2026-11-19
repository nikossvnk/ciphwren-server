from django.db.models import Sum
from fastapi import Depends, Request, status

from etebase_server.django import models
from etebase_server.fastapi.db_hack import django_db_cleanup_decorator
from etebase_server.fastapi.dependencies import get_authenticated_user
from etebase_server.fastapi.exceptions import HttpError
from etebase_server.myauth.models import UserType

# Requests up to this size count as small: deleting or renaming an item, for example
SMALL_REQUEST = 16 * 1024
# How far small requests may go over the limit, so a full account can still delete and tidy up
GRACE = 1024 * 1024


def bytes_used(user_id: int) -> int:
    """Bytes of the chunks in the collections the user owns (all revisions, since old ones are kept)"""
    total = models.CollectionItemChunk.objects.filter(collection__owner_id=user_id).aggregate(total=Sum("size"))
    return total["total"] or 0


@django_db_cleanup_decorator
def check_quota(request: Request, user: UserType = Depends(get_authenticated_user)):
    """A write permission (ETEBASE_API_PERMISSIONS_WRITE) that refuses writes over the owner's limits"""
    collection_uid = request.path_params.get("collection_uid")
    if collection_uid is None:
        # Creating a collection: the user will own it
        owner_id = user.id
    else:
        # The data counts for the owner of the collection, also when a member writes to it
        owner_id = models.Collection.objects.filter(uid=collection_uid).values_list("owner_id", flat=True).first()
        if owner_id is None:
            # Not found: the endpoint answers that
            return

    limits = models.UserLimits.objects.filter(owner_id=owner_id).first()
    if limits is None:
        return
    if limits.read_only:
        raise HttpError("read_only", "This account can't be changed at the moment.", status.HTTP_403_FORBIDDEN)
    if limits.bytes_limit is None:
        return

    try:
        size = int(request.headers.get("content-length", ""))
    except ValueError:
        # Unknown size: treat it as a big request
        size = SMALL_REQUEST + 1
    ceiling = limits.bytes_limit + (GRACE if size <= SMALL_REQUEST else 0)
    if bytes_used(owner_id) + size > ceiling:
        raise HttpError(
            "quota_exceeded",
            "Storage limit reached: delete some data to make room.",
            status.HTTP_413_CONTENT_TOO_LARGE,
        )
