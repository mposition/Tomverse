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
# The base is pinned by the build arg, which has no default on purpose: an
# exact 8.x.y tag at least two weeks old must be chosen at deploy time, and a
# build without one fails rather than pulling whatever "8" means that day.
ARG GOTENBERG_TAG
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
