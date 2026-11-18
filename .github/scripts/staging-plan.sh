#!/usr/bin/env bash
# Which migration files the "Staging database" workflow applies. Nothing is applied unless it is named.
#   staging-plan.sh pending <migrations dir> <applied names file>
#       lists the files on this branch not yet applied, in number order; a file numbered below the
#       highest one already applied (for example M3's reserved 0067 after 0068-0071) is marked
#       "out of order" so it is visible before anyone names it
#   staging-plan.sh apply <migrations dir> <applied names file> "<numbers>"
#       prints the files to apply, in number order, for exactly the numbers named ("0068 0069" or
#       "0068,0069"); refuses (exit 1) if the list is empty or any number is missing on this branch,
#       already applied, or ambiguous
set -u
mode=$1; dir=$2; applied_file=$3; want=$(echo "${4:-}" | tr ',' ' ')
max=$(sed -n 's/^\([0-9][0-9]*\)_.*/\1/p' "$applied_file" | sort | tail -1)
pending() { for f in $(ls "$dir"/*.sql | sort); do n=$(basename "$f"); grep -qx "$n" "$applied_file" || echo "$n"; done; }
case $mode in
  pending)
    p=$(pending)
    [ -z "$p" ] && { echo "(none: every migration on this branch is applied; highest applied $max)"; exit 0; }
    echo "$p" | while read -r n; do
      num=${n%%_*}
      if [ -n "$max" ] && [ "$num" \< "$max" ]; then echo "$n   (out of order: below $max, already applied)"; else echo "$n"; fi
    done ;;
  apply)
    [ -z "${want// /}" ] && { echo "REFUSED: name the migrations to apply (input 'migrations'); 'check' lists what is pending"; exit 1; }
    out=(); bad=()
    for num in $(echo $want | tr ' ' '\n' | sort -u); do
      [[ $num =~ ^[0-9]{4}$ ]] || { bad+=("'$num' is not a 4-digit migration number"); continue; }
      files=$(ls "$dir"/${num}_*.sql 2>/dev/null)
      c=$(echo "$files" | sed '/^$/d' | wc -l)
      if [ "$c" = 0 ]; then bad+=("$num: no such file on this branch"); continue; fi
      if [ "$c" -gt 1 ]; then bad+=("$num: more than one file with this number"); continue; fi
      n=$(basename "$files")
      if grep -qx "$n" "$applied_file"; then bad+=("$n: already applied"); continue; fi
      out+=("$n")
    done
    [ ${#bad[@]} -gt 0 ] && { printf 'REFUSED: %s\n' "${bad[@]}"; exit 1; }
    printf '%s\n' "${out[@]}" ;;
  *) echo "usage: staging-plan.sh pending|apply <dir> <applied file> [numbers]"; exit 2 ;;
esac
