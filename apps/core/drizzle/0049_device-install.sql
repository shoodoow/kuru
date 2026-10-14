-- One push row per install of the app. Rows without an install id (older
-- registrations, Expo Go among them) are dropped when the app registers again.
ALTER TABLE "devices" ADD COLUMN "install_id" text;
