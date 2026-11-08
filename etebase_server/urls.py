from django.contrib import admin
from django.http import HttpResponse
from django.urls import path
from django.views.generic import TemplateView


def robots_txt(request):
    # Nothing on a sync server is meant to be found through search engines
    return HttpResponse("User-agent: *\nDisallow: /\n", content_type="text/plain")


urlpatterns = [
    path("admin/", admin.site.urls),
    path("robots.txt", robots_txt),
    path("", TemplateView.as_view(template_name="index.html")),
]
