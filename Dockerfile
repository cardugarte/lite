FROM denoland/deno:2.1.2 AS builder
WORKDIR /app
COPY . .

RUN deno compile --allow-net --allow-read --allow-env --output main --target x86_64-unknown-linux-gnu src/main.ts

FROM debian:bookworm-slim AS final
WORKDIR /app

COPY --from=builder /app/main /app/main
COPY --from=builder /app/drizzle /app/drizzle
RUN chmod +x /app/main

EXPOSE 8080
CMD ["/app/main"]