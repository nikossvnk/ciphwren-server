"""The admin site with a code from an authenticator app (TOTP) required after the password, when
`ETEBASE_ADMIN_2FA` is on. Set up an admin user's app with `manage.py setup_admin_2fa <username>`."""

from django_otp.admin import OTPAdminAuthenticationForm, OTPAdminSite
from django_otp.plugins.otp_static.models import StaticDevice
from django_otp.plugins.otp_totp.models import TOTPDevice


class LoginForm(OTPAdminAuthenticationForm):
    """Takes the code in one field, without choosing a device: 6 digits are checked against the authenticator app,
    anything else against the backup codes (8 letters and digits). django-otp otherwise needs the device picked from
    a list, because trying every device would count a failed attempt against each one."""

    def _chosen_device(self, user):
        device = super()._chosen_device(user)
        if device is None:
            token = (self.cleaned_data.get("otp_token") or "").strip()
            model = TOTPDevice if len(token) == 6 and token.isdigit() else StaticDevice
            device = model.objects.filter(user=user, confirmed=True).first()
        return device


class AdminSite(OTPAdminSite):
    """Named "admin" like Django's own, so the admin's URL names and templates stay as they are"""

    login_form = LoginForm

    def __init__(self, name="admin"):
        super().__init__(name)
