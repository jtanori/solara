#!/usr/bin/env bash

# Deploy policy decisions, extracted from scripts/deploy.sh so they can be exercised behaviourally
# instead of asserted about by regex. Each function prints a decision token and never exits; the
# caller decides what to do with it. That split is what makes the guard mutation-testable.

# decide_skip_migrate <needs_migrate:true|false> <skip:true|false> <force:true|false> <env>
# Prints one of:
#   apply            — run the remote migrate step
#   skip             — nothing to apply (no drizzle/ change)
#   skip-forced      — the operator asked to skip AND forced it (non-production only)
#   refuse-production— --skip-migrate is never allowed for production
#   refuse-force     — --skip-migrate needs --force
decide_skip_migrate() {
  local needs="$1" skip="$2" force="$3" env="$4"
  if [[ "$needs" != true ]]; then printf 'skip'; return 0; fi
  if [[ "$skip" != true ]]; then printf 'apply'; return 0; fi
  if [[ "$env" == production ]]; then printf 'refuse-production'; return 0; fi
  if [[ "$force" != true ]]; then printf 'refuse-force'; return 0; fi
  printf 'skip-forced'
}

# decide_rollback <token:present|absent> <target:nonempty|empty>
# Prints: auto | manual-no-credentials | manual-no-target
decide_rollback() {
  local credentials="$1" target="$2"
  if [[ "$credentials" != present ]]; then printf 'manual-no-credentials'; return 0; fi
  if [[ -z "$target" ]]; then printf 'manual-no-target'; return 0; fi
  printf 'auto'
}
