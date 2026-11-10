export type MigrationManifestEntry = {
  tag: string;
  hash: string;
};

export const EXPECTED_MIGRATIONS: MigrationManifestEntry[] = [
  {
    "tag": "0000_initial",
    "hash": "657f9f9837ba919343d7734842e7116ed93b32280e18e10aebd16cfa8a6d459e"
  },
  {
    "tag": "0001_rate_limits",
    "hash": "9e24464530cc11987abadd50e26f7e61a54f55440bf2d2218c14111db33ee041"
  },
  {
    "tag": "0002_email_verification",
    "hash": "f9bb593a6f31e69a728d902d4cb98a6c91adbee6ae6a36cc56b5f3a26d96ff8c"
  }
];
