import io

import segno
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django_otp.plugins.otp_static.models import StaticDevice, StaticToken
from django_otp.plugins.otp_totp.models import TOTPDevice

BACKUP_CODES = 10


class Command(BaseCommand):
    help = (
        "Sets up the authenticator app (TOTP) that an admin user needs to log in to the admin site (ETEBASE_ADMIN_2FA), and prints "
        "its QR code and one-time backup codes. Only shown once: nothing here can show them again."
    )

    def add_arguments(self, parser):
        parser.add_argument("username")
        parser.add_argument(
            "--replace", action="store_true", help="Replace the user's authenticator and backup codes (lost phone)"
        )

    def handle(self, *args, **options):
        user = get_user_model().objects.filter(username=options["username"]).first()
        if user is None or not user.is_staff:
            raise CommandError(f"No admin user {options['username']!r}")
        has_devices = TOTPDevice.objects.filter(user=user).exists() or StaticDevice.objects.filter(user=user).exists()
        if has_devices and not options["replace"]:
            raise CommandError("This user already has an authenticator; pass --replace to replace it")

        with transaction.atomic():
            TOTPDevice.objects.filter(user=user).delete()
            StaticDevice.objects.filter(user=user).delete()
            totp = TOTPDevice.objects.create(user=user, name="authenticator", confirmed=True)
            backup = StaticDevice.objects.create(user=user, name="backup codes", confirmed=True)
            codes = [StaticToken.random_token() for _ in range(BACKUP_CODES)]
            StaticToken.objects.bulk_create(StaticToken(device=backup, token=code) for code in codes)

        url = totp.config_url
        qr = io.StringIO()
        segno.make(url, micro=False).terminal(out=qr, compact=True)
        self.stdout.write("Scan this with an authenticator app:\n")
        self.stdout.write(qr.getvalue())
        self.stdout.write(f"\nOr enter this link in the app: {url}\n")
        self.stdout.write("\nBackup codes, each works once instead of a code from the app (keep them offline):\n")
        self.stdout.write("\n".join(codes) + "\n")
