from django.conf import settings
from django.contrib.admin.apps import AdminConfig as DjangoAdminConfig


class AdminConfig(DjangoAdminConfig):
    """Django's admin; `admin.site` needs a TOTP code at login when ETEBASE_ADMIN_2FA is on (admin_2fa.py)"""

    @property
    def default_site(self):
        if settings.ETEBASE_ADMIN_2FA:
            return "etebase_server.admin_2fa.AdminSite"
        return "django.contrib.admin.sites.AdminSite"
