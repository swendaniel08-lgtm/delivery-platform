#!/bin/bash
# Creates one database per service (dev only; prod uses separate instances).
set -eu
for db in $(echo "$POSTGRES_MULTIPLE_DATABASES" | tr ',' ' '); do
  echo "creating database: $db"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" <<-SQL
    CREATE DATABASE "$db";
SQL
done
