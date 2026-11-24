export type MigrationManifestEntry = {
  tag: string;
  hash: string;
  when: number;
};

export const EXPECTED_MIGRATIONS: MigrationManifestEntry[] = [
  {
    "tag": "0000_initial",
    "hash": "657f9f9837ba919343d7734842e7116ed93b32280e18e10aebd16cfa8a6d459e",
    "when": 1794029500342
  },
  {
    "tag": "0001_rate_limits",
    "hash": "9e24464530cc11987abadd50e26f7e61a54f55440bf2d2218c14111db33ee041",
    "when": 1794163484410
  },
  {
    "tag": "0002_email_verification",
    "hash": "f9bb593a6f31e69a728d902d4cb98a6c91adbee6ae6a36cc56b5f3a26d96ff8c",
    "when": 1794163672763
  },
  {
    "tag": "0003_readings_documents_generation_cache",
    "hash": "b3af103ee2e83fc3bca510736383d96c7acc6b70b502f1272228ced203199120",
    "when": 1794325873256
  },
  {
    "tag": "0004_yielding_speed_demon",
    "hash": "43d0e7b824bac056d2bf48717cf04b61435c199c7a366effd1feb90a6b32b31a",
    "when": 1794566005509
  },
  {
    "tag": "0005_account_lifecycle_leases",
    "hash": "ccb7a3569e0132e2637f2c9bbda33a953139b1199955733e01188748c324fc01",
    "when": 1794788488996
  },
  {
    "tag": "0006_reading_generation_safety",
    "hash": "7052c0d61022ad92a58d62053f2c9f965cf2f006c4f1fda107061781eb1c8525",
    "when": 1794860849952
  },
  {
    "tag": "0007_paid_reading_editions",
    "hash": "3b113d8ae628189dfb00f74364eead8d39b2b37f7deaeeafa2d14e38efb3fe8b",
    "when": 1794919620573
  },
  {
    "tag": "0008_paid_annual_facts",
    "hash": "9f1565c5656b626e76c51e2ee98adc3f3b597670cfd4159f20110b8e35fa065c",
    "when": 1794921828602
  },
  {
    "tag": "0009_reading_chart_facts",
    "hash": "f91731efcb43d35339f756464b35d997f476c76a374b601bb9938892d0a89624",
    "when": 1794990879224
  }
];
