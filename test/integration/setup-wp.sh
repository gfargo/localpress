#!/bin/bash
# Setup script for the integration test WordPress instance.
# Run this after the container is healthy to configure WP and create test data.
#
# Usage: docker compose exec -T wordpress bash /usr/local/bin/setup-wp.sh

set -euo pipefail

# Apache listens on port 80 inside the container — use this for the health-check curl.
WP_INTERNAL_URL="http://localhost:80"
# URL as seen by clients connecting from outside (matches docker-compose port mapping 8880:80).
# Override via WP_SITE_URL env var if your port mapping differs.
WP_SITE_URL="${WP_SITE_URL:-http://localhost:8880}"
ADMIN_USER="admin"
ADMIN_PASS="admin123"
ADMIN_EMAIL="admin@localpress.test"

# Wait for WordPress to be ready.
until curl -sf "$WP_INTERNAL_URL/wp-login.php" > /dev/null 2>&1; do
  echo "Waiting for WordPress..."
  sleep 2
done

# Install WP-CLI.
if ! command -v wp &> /dev/null; then
  curl -sO https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
  chmod +x wp-cli.phar
  mv wp-cli.phar /usr/local/bin/wp
fi

# Install WordPress if not already installed.
if ! wp core is-installed --path=/var/www/html --allow-root 2>/dev/null; then
  wp core install \
    --url="$WP_SITE_URL" \
    --title="localpress test" \
    --admin_user="$ADMIN_USER" \
    --admin_password="$ADMIN_PASS" \
    --admin_email="$ADMIN_EMAIL" \
    --path=/var/www/html \
    --allow-root \
    --skip-email
fi

# Pretty permalinks are required for /wp-json/ REST API routing.
wp rewrite structure "/%postname%/" --path=/var/www/html --allow-root
wp rewrite flush --hard --path=/var/www/html --allow-root

# WordPress 5.9+ disables Application Passwords on non-SSL sites.
# Add a must-use plugin to re-enable them for this HTTP test environment.
mkdir -p /var/www/html/wp-content/mu-plugins
echo '<?php add_filter("wp_is_application_passwords_available", "__return_true");' \
  > /var/www/html/wp-content/mu-plugins/enable-app-passwords.php

# Register a custom post type with a non-default rest_base, so integration
# tests can verify typeEndpoint() resolves custom types correctly (not just
# slug-based defaults).
cat > /var/www/html/wp-content/mu-plugins/register-lp-item-cpt.php <<'PHP'
<?php
add_action('init', function () {
    register_post_type('lp_item', [
        'public' => true,
        'show_in_rest' => true,
        'rest_base' => 'lp-items',
        'supports' => ['title', 'editor', 'custom-fields'],
    ]);
});
PHP

# Ensure Apache passes the Authorization header to PHP.
# Some Apache+mod_php builds strip it before PHP sees it; SetEnvIf copies it back.
echo 'SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1' \
  > /etc/apache2/conf-available/auth-pass.conf
a2enconf auth-pass

# Belt-and-suspenders: also add a RewriteRule passthrough in .htaccess.
if [ -f /var/www/html/.htaccess ]; then
  if ! grep -q "HTTP_AUTHORIZATION" /var/www/html/.htaccess; then
    sed -i 's|RewriteEngine On|RewriteEngine On\nRewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]|' \
      /var/www/html/.htaccess
  fi
fi

apache2ctl graceful
sleep 2

# Create an Application Password for the admin user.
# WP-CLI outputs the password; we capture it.
APP_PASS=$(wp user application-password create "$ADMIN_USER" "localpress-test" \
  --porcelain \
  --path=/var/www/html \
  --allow-root 2>/dev/null || true)

if [ -z "$APP_PASS" ]; then
  echo "Application Password may already exist. Deleting and recreating..."
  wp user application-password delete "$ADMIN_USER" --all \
    --path=/var/www/html \
    --allow-root 2>/dev/null || true
  APP_PASS=$(wp user application-password create "$ADMIN_USER" "localpress-test" \
    --porcelain \
    --path=/var/www/html \
    --allow-root)
fi

# Write machine-readable env file so CI can extract APP_PASS with docker compose exec cat.
echo "APP_PASS=$APP_PASS" > /tmp/wp-test-env

echo ""
echo "========================================="
echo "WordPress integration test environment"
echo "========================================="
echo "URL:              $WP_SITE_URL"
echo "Admin user:       $ADMIN_USER"
echo "Admin password:   $ADMIN_PASS"
echo "App Password:     $APP_PASS"
echo ""
echo "Use these values in your test config:"
echo "  localpress init --url $WP_SITE_URL --username $ADMIN_USER --app-password \"$APP_PASS\""
echo "========================================="

# Upload a few test images so the media library isn't empty.
# Create simple test images using PHP's GD library.
php -r '
$img = imagecreatetruecolor(800, 600);
$bg = imagecolorallocate($img, 100, 150, 200);
imagefill($img, 0, 0, $bg);
$text = imagecolorallocate($img, 255, 255, 255);
imagestring($img, 5, 300, 280, "Test Image 1", $text);
imagejpeg($img, "/tmp/test-image-1.jpg", 95);
imagedestroy($img);

$img = imagecreatetruecolor(1200, 800);
$bg = imagecolorallocate($img, 200, 100, 100);
imagefill($img, 0, 0, $bg);
$text = imagecolorallocate($img, 255, 255, 255);
imagestring($img, 5, 500, 380, "Test Image 2", $text);
imagejpeg($img, "/tmp/test-image-2.jpg", 95);
imagedestroy($img);

$img = imagecreatetruecolor(400, 400);
$bg = imagecolorallocate($img, 50, 200, 50);
imagefill($img, 0, 0, $bg);
$text = imagecolorallocate($img, 255, 255, 255);
imagestring($img, 5, 140, 190, "Test PNG", $text);
imagepng($img, "/tmp/test-image-3.png");
imagedestroy($img);
'

for f in /tmp/test-image-*.{jpg,png}; do
  if [ -f "$f" ]; then
    wp media import "$f" \
      --path=/var/www/html \
      --allow-root \
      --title="$(basename "$f" | sed 's/\.[^.]*$//')" \
      2>/dev/null || true
  fi
done

echo "Uploaded test images to the media library."

# Fix ownership so Apache (www-data) can write to uploads via the REST API.
# WP-CLI ran as root above and may have created directories owned by root.
chown -R www-data:www-data /var/www/html/wp-content
