FROM docker.io/library/nginx:alpine

# Remove default nginx configs and assets
RUN rm -rf /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy raw static files directly
COPY index.html sw.js manifest.json browserconfig.xml /usr/share/nginx/html/
COPY icons /usr/share/nginx/html/icons

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
