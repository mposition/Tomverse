# The web service stays on railpack.json provider node. This file lives
# beside the orchestrator so a root Dockerfile cannot switch that service
# to Docker. Build context is the repository root.
FROM rust:1.98.1-bookworm AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock ./
COPY crates/amux-core ./crates/amux-core
COPY apps/tomverse-orchestrator ./apps/tomverse-orchestrator

RUN cargo build --release --locked -p tomverse-orchestrator

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/tomverse-orchestrator /usr/local/bin/tomverse-orchestrator

USER nobody

CMD ["/usr/local/bin/tomverse-orchestrator"]
