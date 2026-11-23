FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS base

RUN apt-get update && \
    apt-get install -y --no-install-recommends libevent-core-2.1-7t64 libevent-extra-2.1-7t64 \
        libevent-openssl-2.1-7t64 libevent-pthreads-2.1-7t64 libmicrohttpd12t64 libsqlite3-0 libssl3t64 && \
    rm -rf /var/lib/apt/lists/*

FROM base AS build
RUN apt-get update && \
    apt-get install -y --no-install-recommends g++ libevent-dev libmicrohttpd-dev libsqlite3-dev \
        libssl-dev make patch pkg-config
ADD --checksum=sha256:2c80e4dffd0eb410951ba469f5cf8bd9b4a0658afc72d816f5c519c0c988d75c \
    https://codeload.github.com/coturn/coturn/tar.gz/refs/tags/4.19.2 /tmp/coturn.tar.gz
COPY cap-default-refresh.patch /tmp/cap-default-refresh.patch
RUN mkdir /src && tar -xzf /tmp/coturn.tar.gz --strip-components=1 -C /src
WORKDIR /src
RUN patch -p1 < /tmp/cap-default-refresh.patch && \
    CFLAGS=-O3 ./configure --disable-rpath && make -j2 && \
    install -m 0755 bin/turnserver /usr/local/bin/screen-turnserver

FROM base
COPY --from=build /usr/local/bin/screen-turnserver /usr/local/bin/screen-turnserver
COPY --from=build /src/LICENSE /usr/share/doc/screen-turnserver/copyright
USER nobody:nogroup
ENTRYPOINT ["/usr/local/bin/screen-turnserver"]
