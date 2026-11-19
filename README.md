<p align="center">
  <img width="120" src="icon.svg" />
  <h1 align="center">Ciphwren Server</h1>
</p>

> [!NOTE]
> **This is an independent fork** of the [Etebase server](https://github.com/etesync/server), the original
> project of the EteSync authors. This fork is not affiliated with, endorsed by or supported by EteSync, Etebase or
> [etesync.com](https://www.etesync.com) in any way. The history of the original project is kept as it is,
> with its authors, and the changes of this fork follow it. Like the original, it's licensed under the AGPL-3.0.

An Etebase (EteSync 2.0) server so you can run your own.

# Installation

## Requirements

Etebase requires Python 3.10 or newer and has a few Python dependencies (listed in `requirements.in`).

## From source

Before installing the Etebase server make sure you install `virtualenv` (for **Python 3**):

* Arch Linux: `pacman -S python-virtualenv`
* Debian/Ubuntu: `apt-get install python3-virtualenv`
* Mac/Windows (WSL)/Other Linux: install virtualenv or just skip the instructions mentioning virtualenv.

Then just clone the git repo and set up this app:

```
git clone https://github.com/etesync/server.git etebase

cd etebase

# Set up the environment and deps
virtualenv -p python3 .venv  # If doesn't work, try: virtualenv3 .venv
source .venv/bin/activate

pip install -r requirements.txt
```

# Configuration

If you are familiar with Django you can just edit the [settings file](etebase_server/settings.py)
according to the [Django deployment checklist](https://docs.djangoproject.com/en/dev/howto/deployment/checklist/).
If you are not, we also provide a simple [configuration file](etebase-server.ini.example) for easy deployment which you can use.
To use the easy configuration file rename it to `etebase-server.ini` and place it either at the root of this repository or in `/etc/etebase-server`.

There is also a [wikipage](https://github.com/etesync/server/wiki/Basic-Setup-Etebase-(EteSync-v2)) detailing this basic setup.

Some particular settings that should be edited are:
  * [`ALLOWED_HOSTS`](https://docs.djangoproject.com/en/dev/ref/settings/#std:setting-ALLOWED_HOSTS)
    -- this is the list of host/domain names or addresses on which the app
will be served. For example: `etebase.example.com`
  * [`DEBUG`](https://docs.djangoproject.com/en/dev/ref/settings/#debug)
    -- handy for debugging, set to `False` for production
  * [`MEDIA_ROOT`](https://docs.djangoproject.com/en/dev/ref/settings/#media-root)
    -- the path to the directory that will hold user data.
  * [`SECRET_KEY`](https://docs.djangoproject.com/en/dev/ref/settings/#std:setting-SECRET_KEY)
    -- an ephemeral secret used for various cryptographic signing and token
generation purposes. See below for how default configuration of
`SECRET_KEY` works for this project.

Now you can initialise our django app.

```
./manage.py migrate
```

Create static files:

```
./manage.py collectstatic
```

And you are done! You can now run the debug server just to see everything works as expected by running:

```
uvicorn etebase_server.asgi:application --host 0.0.0.0 --port 8000
```

Using the debug server in production is not recommended, so please read the following section for a proper deployment.

# Production deployment

There are more details about a proper production setup using uvicorn and Nginx in the [wiki](https://github.com/etesync/server/wiki/Production-setup-using-Nginx).

The webserver should also be configured to serve Etebase using TLS.
A guide for doing so can be found in the [wiki](https://github.com/etesync/server/wiki/Setup-HTTPS-for-Etebase) as well.

The Etebase server needs to be aware of the URL it's been served as, so make sure to forward the `Host` header to the server if using a reverse proxy. For example, you would need to use the following directive in nginx: `proxy_set_header Host $host;`.

# Data locations and backups

The server stores user data in two different locations that need to be backed up:
1. The database - how to backup depends on which database you use.
2. The `MEDIA_ROOT` - the path where user data is stored.

# Usage

Create yourself an admin user:

```
./manage.py createsuperuser
```

At this stage you need to create accounts to be used with the apps (Ciphwren or other Etebase apps). To do that, please go to:
`etebase.example.com/admin` and create a new user to be used with the service. No need to set
a password, as Etebase uses a zero-knowledge proof for authentication, so the user will just create
a password when creating the account from the apps.

After this user has been created, you can use any of the apps to sign up (or login) with the same username and
email in order to set up the account. The password used at that point will be used to setup the account.
Don't forget to set your custom server address under "Advanced".

# `SECRET_KEY` and `secret.txt`

The default configuration creates a file “`secret.txt`” in the project’s
base directory, which is used as the value of the Django `SECRET_KEY`
setting. You can revoke this key by deleting the `secret.txt` file and the
next time the app is run, a new one will be generated. Make sure you keep
the `secret.txt` file secret (e.g. don’t accidentally commit it to version
control). However, backing it up is okay, and it makes it easier to restore
the database to a new Etebase server, but it's not essential. If you want to
change to a more secure system for storing secrets, edit `etebase_server/settings.py`
and implement your own method for setting `SECRET_KEY` (remove the line
where it uses the `get_secret_from_file` function).  Read the Django docs
for more information about the `SECRET_KEY` and its uses.

# Updating

## Updating from version 0.5.0 onwards

First, run `git pull --rebase` to update this repository.
Then, inside the virtualenv:
1. Run `pip install -U -r requirements.txt` to update the dependencies.
2. Run `python manage.py migrate` to perform database migrations.

You can now restart the server.

## Updating from version 0.5.0 or before

The 0.5.0 release marks the change to the EteSync 2.0 protocol. EteSync 2.0 accounts are substantially different to 1.0 accounts, and require additional upgrade steps. In addition, the servers are incompatible, so 0.5.0 requires a fresh installation.

Here are the update steps:
1. Choose a migration tool (the EteSync 1.0 apps of the original project had one) and make sure the underlying apps are up to date with all of your data. So for example, if you are using the Android client, make sure to sync before commencing.
2. Install the 0.5.0 version to a new path (you can't reuse the same database).
3. Run the 0.5.0 account and create the appropriate users as described in the installation/upgrade steps above.
4. Run the migration tool to migrate all of your data.
5. Add your new EteSync 2.0 accounts to all of your devices.

# Docker

`docker/server/Dockerfile` builds an image to run the server with. It's not in debug mode, only the admin can create users, and it keeps all of its data (the database, the configuration and the secret key) in the `/data` volume.

```
docker build -t etebase-server -f docker/server/Dockerfile .
docker run -d --name etebase -p 3735:3735 -v etebase-data:/data -e ETEBASE_ALLOWED_HOSTS=etebase.example.com etebase-server
docker exec -it etebase python manage.py createsuperuser
```

`ETEBASE_ALLOWED_HOSTS` is the host name (or names, separated by commas) the server is reached at. It's only used the first time the server is started, to create `/data/etebase-server.ini`, which can be changed afterwards.
The server listens on port 3735 without encryption, so put it behind a reverse proxy that handles TLS, as described in the production deployment section above.
The image uses SQLite. To use another database add its driver to the image and change the `[database]` section of the configuration.

The image is published to the GitHub container registry when a version tag is pushed.

To run it in production, behind a reverse proxy that takes care of HTTPS, see [deploy/README.md](deploy/README.md).

# Testing

Docker images named `etesync/test-server:<version>` and `:latest` are available for testing Etebase clients (amd64 only).
This fork publishes the same image for amd64 and arm64 as `ghcr.io/nikossvnk/ciphwren-server/test-server:<version>` and `:latest` when a version tag is pushed. To build it locally for the machine's own architecture, run `docker/build.sh`.
This docker image starts a server on port 3735 that supports user signup (without email confirmation), is in debug mode (thus supporting the reset endpoint), and stores its data locally.
It is in no way suitable for production usage, but is able to start up quickly and makes a good component of CI for Etebase clients and users of those clients.

# User signup

Instead of having to create Django users manually when signup up Etebase users, it is also possible to allow automatic signup.
For example, this makes sense when putting an Etebase server in production.
However, this does come with the added risk that everybody with access to your server will be able to sign up.

In order to set it up, comment out the line `ETEBASE_CREATE_USER_FUNC = "etebase_server.django.utils.create_user_blocked"` in `server/settings.py` and restart your Etebase server.

## Signup through an account service (internal API)

A hosted server can leave signup closed and let an account service (one that verifies email addresses, for
example) create the users instead. Set the environment variable `ETEBASE_INTERNAL_API_SECRET` to a random
secret of at least 32 characters (several, separated by commas, while switching to a new one): the server
then serves an internal API under `/internal/v1/`, for requests with the header `Authorization: Internal
<secret>`. Without the variable these routes don't exist.

The internal API must only be reachable from the private network the account service runs in: never let the
public reverse proxy forward `/internal/` (`deploy/Caddyfile` answers it with 404). Its endpoints:

- `POST signup/`: creates a user from a client's signup request, `{"signup": "<the client's request body,
  base64url>", "expected_email": "<the verified address>", "limits": {…}}` (`limits` optional, as below).
  The answer's `login` (base64url) is the response to give back to the client.
- `GET username-available/?username=…`, `GET users/by-username/<username>/`
- `POST whoami/` with `{"token": "<an Etebase login token>"}`: whose token it is.
- `GET users/<id>/usage/`: bytes stored in the collections the user owns (all revisions), their limit,
  the number of collections (and how many are shared) and items, the last login.
- `PUT users/<id>/limits/` with `{"bytes_limit": <bytes or null>, "read_only": <bool>}`.
- `PUT users/<id>/email/` with `{"email": "…"}`: the address the user logs in with and is invited by (the
  account service verifies it first).
- `POST users/<id>/suspend/` and `unsuspend/`: a suspended user's logins stop working at once.
- `DELETE users/<id>/`: deletes the user, the collections they own (for their members too), their
  memberships and their chunk files. Deleting a user that doesn't exist does nothing.

Users with limits can't make changes that would store more than `bytes_limit` in their collections (also
changes by members of a shared collection count for its owner), and none at all while `read_only`. Small
requests (up to 16 KiB, like deleting an item) may go up to 1 MiB over the limit, so a full account can still
tidy up. Users without limits are not affected.

Answers and errors (`{"code": …, "detail": …}`) are JSON. The account service reaches the server by a host
name that is in `[allowed_hosts]`, or sends one in its `Host` header.

## The apps' "Account Dashboard" button

With `ETEBASE_DASHBOARD_URL` (the dashboard's page for it, e.g. `https://app.example.com/ticket`) and
`ETEBASE_DASHBOARD_TICKET_SECRET` (at least 32 characters) set, the button opens the dashboard with a one-time
login ticket in the URL's fragment: `<payload>.<signature>`, both base64url, where the payload is JSON
`{"uid": <user id>, "exp": <unix time, a minute ahead>, "nonce": "…"}` and the signature its HMAC-SHA256 with
the secret. The dashboard's account service checks the signature, the expiry and that the nonce wasn't used.

# Wrong passwords

After 5 wrong passwords in a row for a user, from any address, each next try has to wait: 1 second, then twice
as long after each further wrong password, up to a minute (answer 429 `too_many_attempts` until then). It's a
slowdown, not a lockout: someone trying wrong passwords on purpose can make the user wait up to a minute, not
lock them out. The count is forgotten after the right password or 15 minutes. It's kept in Django's cache, per
server process.

# License

Ciphwren Server is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License version 3 as published by the Free Software Foundation. See the [LICENSE](./LICENSE) for more information.

A quick summary can be found [on tldrlegal](https://tldrlegal.com/license/gnu-affero-general-public-license-v3-(agpl-3.0)). Though in even simpler terms (not part of the license, and not legal advice): you can use it in however way you want, including self-hosting and commercial offerings as long as you release the code to any modifications you have made to the server software (clients are not affected).
