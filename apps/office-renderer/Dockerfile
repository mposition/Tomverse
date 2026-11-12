# Office renderer: Gotenberg (LibreOffice behind an HTTP API) for Tomverse.
#
# Policy: docs/policy/generated-artifacts.md section 15.
# Deployment: docs/ops/office-renderer.md.
#
# What this adds to the stock image, and why:
#   * libreoffice-h2orestart -- stock LibreOffice reads HWP 97 only. This
#     Debian-packaged filter (GPL-3.0-or-later, Java) reads HWP 5.x and HWPX,
#     the Hangul formats Korean users actually have.
#   * Korean fonts (Nanum, Noto CJK) -- without them LibreOffice substitutes
#     fonts and a Korean document lays out with shifted pages.
#
# Pin the base to an exact 8.x tag at least two weeks old before deploying;
# the build arg keeps the tag in one place.
ARG GOTENBERG_TAG=8
FROM gotenberg/gotenberg:${GOTENBERG_TAG}

USER root

RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
         libreoffice-h2orestart \
         fonts-nanum \
         fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

USER gotenberg
