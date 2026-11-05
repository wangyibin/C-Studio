FROM ubuntu:22.04 AS build

RUN --mount=type=cache,id=cstudio-jammy-amd64-apt,target=/var/cache/apt/archives,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates build-essential pkg-config curl wget file patchelf git python3 xz-utils unzip \
        libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev \
        librsvg2-dev libfuse2 qemu-user && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL --retry 3 -o /tmp/pixi.tar.gz \
        https://github.com/prefix-dev/pixi/releases/download/v0.75.0/pixi-x86_64-unknown-linux-musl.tar.gz && \
    echo 'bcd825d62905c29b3c754b71f9cdc9d6f119454398f58330f111a7b6a0de0a3f  /tmp/pixi.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/pixi.tar.gz -C /usr/local/bin pixi && rm /tmp/pixi.tar.gz

# Rosetta runs the desktop executable, but the AppImage output plugin has a
# static PIE launcher. Run that build tool under QEMU inside the container.
RUN mkdir -p /root/.cache/tauri && \
    curl -fsSL --retry 3 -o /opt/appimage-plugin \
        https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage && \
    echo '992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3  /opt/appimage-plugin' | sha256sum -c - && \
    printf '%s\n' '#!/bin/sh' 'exec /usr/bin/qemu-x86_64 /opt/appimage-plugin "$@"' \
        > /root/.cache/tauri/linuxdeploy-plugin-appimage.AppImage && \
    chmod +x /opt/appimage-plugin /root/.cache/tauri/linuxdeploy-plugin-appimage.AppImage && \
    APPIMAGE_EXTRACT_AND_RUN=1 /root/.cache/tauri/linuxdeploy-plugin-appimage.AppImage --plugin-api-version

WORKDIR /work
COPY pixi.toml pixi.lock ./
RUN --mount=type=cache,target=/root/.cache/rattler pixi install --locked -e package

COPY . .
ARG RELEASE_TAG
ENV CARGO_BUILD_JOBS=4
RUN --mount=type=cache,target=/root/.cargo/registry,sharing=locked \
    --mount=type=cache,target=/root/.npm \
    pixi run --locked -e package package-linux && \
    bundle=src-tauri/target/x86_64-unknown-linux-gnu/release/bundle && \
    name="C-Studio_${RELEASE_TAG#v}_amd64" && mkdir /packages && \
    cp "$bundle/deb/$name.deb" "$bundle/appimage/$name.AppImage" /packages/ && \
    rm -rf src-tauri/target

FROM scratch AS packages
COPY --from=build /packages/ /
