# Workable live notes — TechConnect `FC0E026A69` (2026-11-10)

Observed against `https://apply.workable.com/techconnect/j/FC0E026A69` with a headless
probe (`node --headless`-style script, `scripts/browser.mjs`), screenshots under
`screenshots/` (`probe-*`, `final-after-fill.png`). The saved snapshot
`fixtures/ats/workable/form.html` already matches the live markup; its option lists are
rendered only after a click, exactly as live, so the snapshot needed no refresh.

## Controls, live strategy, result

| Control | Live strategy | Result |
| --- | --- | --- |
| First name, Last name, Email, LinkedIn URL, University, GPA, Major of Study, salaries | label fill (`aria-labelledby`) | works |
| Phone | label match now prefers the `input[name=phone]`, not intl-tel-input's decoy country button; the `[class*="select"]` combobox sniff wrongly matched `iti--has-country-selector` and routed the phone to the option path | works |
| Resume | file input via `getByLabel('Resume')` | works |
| Nationality, Notice Period, Total Working Experience, Gender, Religion, Marital Status, Year of Graduation | readonly combobox → click, pick option from the widget's own `listbox`, accept the value when the draft already holds it | works |
| Work Eligibility | live options are `Yes, by way of Citizenship` / `Yes, by way of having work permit` / `No`; mapped from `work.authorizedIn == work.citizenship` in the adapter | works |
| Education Degree | live options are `S1` / `S2` / `D3` / `D4`; adapter maps the degree name to its stratum (`B.Sc.` → `S1`) | works |
| Birth Date | `react-datepicker` input, placeholder `MM/DD/YYYY`; `fill()` is discarded, so the ISO profile date is typed as `04/03/2002` | works |
| By submitting this form | `fieldset[role=radiogroup]` with `YES`/`NO` clickable wrappers; boolean consent clicks `YES` (aria-checked and the hidden input both update) | works |
| Employees who have family ties with your relatives | live label wraps the manifest wording in a long question; resolved by all-significant-words label matching | works |
| Job Vacancy to Apply | control exists and opens, but the live list offers only `ENDP Geotech Officer`, `ENDP Geotech Engineer`, `ENDP Facilities & Maintenance`, `Grade Control` — the posted role is not in it | **blocked**: no profile answer, no live option; a human must choose |

## Notes

- Workable restores the applicant's draft between runs (first name, phone, birth place,
  combobox picks). Re-selecting the same option leaves the value unchanged, which the
  old "value must change" check read as a failure; an already-correct value is now
  accepted without a second click.
- `requiredEmptyControls` treats a radio group as answered when any member is checked
  (`aria-checked` on the wrapper counts); the old per-input check reported the unchecked
  sibling of the consent group and blocked forever.
- `Address`, `City` and `Website` are not Workable controls: neither live nor in the
  snapshot. Their map entries were removed rather than left as permanently unfillable.
