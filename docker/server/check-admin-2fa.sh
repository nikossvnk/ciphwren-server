#! /bin/bash
# Starts the server image with ETEBASE_ADMIN_2FA on and checks that the admin site lets an admin in only with
# a code from the authenticator app or a backup code (each backup code once), not with the password alone.
# Used by CI: check-admin-2fa.sh <docker or podman> <image>
set -euo pipefail

engine="$1"
image="$2"
name=server-2fa
url=http://127.0.0.1:3737
password="a long admin password"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

"$engine" rm -f "$name" >/dev/null 2>&1 || true
"$engine" run -d --name "$name" -e ETEBASE_ALLOWED_HOSTS=127.0.0.1 -e ETEBASE_ADMIN_2FA=true \
    -p 127.0.0.1:3737:3735 "$image" >/dev/null
timeout 60 sh -c "until curl -sf -o /dev/null $url/api/v1/authentication/is_etebase/; do sleep 1; done"

manage() { "$engine" exec -e DJANGO_SUPERUSER_PASSWORD="$password" "$name" python manage.py "$@"; }
manage createsuperuser --noinput --username admin --email admin@example.com >/dev/null
backup_code="$(manage setup_admin_2fa admin | tail -1)"
app_code() {
    manage shell -v 0 -c "from django_otp.oath import TOTP; from django_otp.plugins.otp_totp.models import TOTPDevice
d = TOTPDevice.objects.get(); print(f'{TOTP(d.bin_key, d.step, d.t0, d.digits, d.drift).token():06d}')"
}

# Logs in with a fresh session and prints the status of the admin's main page afterwards (200: in, 302: not)
log_in() {
    rm -f "$jar"
    curl -sf -c "$jar" -b "$jar" -o /dev/null "$url/admin/login/"
    token="$(awk '$6 == "csrftoken" { print $7 }' "$jar")"
    curl -s -c "$jar" -b "$jar" -o /dev/null -H "Referer: $url/admin/login/" \
        --data-urlencode "csrfmiddlewaretoken=$token" --data-urlencode "username=admin" \
        --data-urlencode "password=$password" --data-urlencode "otp_token=$1" "$url/admin/login/?next=/admin/"
    curl -s -b "$jar" -o /dev/null -w '%{http_code}' "$url/admin/"
}

expect() {
    if [ "$2" != "$3" ]; then
        echo "::error::$1: expected $2, got $3"
        exit 1
    fi
    echo "ok - $1"
}
expect "the password alone doesn't log in" 302 "$(log_in "")"
expect "a wrong code doesn't log in" 302 "$(log_in 000000)"
# After a wrong code, django-otp refuses any code for a second (doubling with each further wrong one)
sleep 2
expect "a code from the app logs in" 200 "$(log_in "$(app_code)")"
expect "a backup code logs in" 200 "$(log_in "$backup_code")"
expect "a backup code works only once" 302 "$(log_in "$backup_code")"
"$engine" rm -f "$name" >/dev/null
