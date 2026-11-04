# Architecture

## Principles

1. **Screens never touch data directly.** Every page calls `UserApi` or `AdminApi` (`packages/core/src/api/contract.ts`). Two implementations exist: `createHttpApi` / `createHttpAdminApi` (the RIFLO API, used when `VITE_API_URL` is set) and `createMockApi` / `createMockAdminApi` (in-browser, used by the shareable previews). `app/services.tsx` picks one; pages never know which.
2. **One source for the look.** Colours, spacing, radii and type come from `packages/ui/src/styles/tokens.css`, which mirrors the RIFLO Design System. Components in `@riflo/ui` are the only place component styling lives; app CSS handles page layout only.
3. **Feature folders.** Each user-facing area owns its page and its pieces:
   `apps/web/src/features/{home,create-trip,trip,places,passport,explore}`.
4. **All copy in one dictionary.** `apps/*/src/i18n/ar.ts`. Adding English = an `en.ts` with the same shape plus flipping `dir` on `<html>`. Layout uses logical CSS properties (`inline-start`), so RTL/LTR mirroring is automatic.
5. **Every async screen has three states.** `useAsync` returns `loading | error | ready`; pages render a skeleton, an `ErrorState` with retry, or content. Empty states use `EmptyState`.
6. **No sample data posing as real.** Unknown costs and hours stay `null` and render as "not added yet"; admin metrics render "—" until analytics exist; both apps show a sample-data label.

## Packages

### `@riflo/core`

| File | Responsibility |
| --- | --- |
| `types.ts` | Place, Trip, TripDay, Stop, Passport, Visit, AdminOverview… |
| `planner.ts` | `generatePlan` (rank by interests and wish list → group per day → order as a route → schedule with travel time and prayer breaks), `rescheduleDay` after edits, `estimateBudget` |
| `geo.ts` | Distance and a travel-time estimate (replaceable by a routing API) |
| `api/contract.ts` | `UserApi`, `AdminApi`, `ApiError` |
| `api/mock.ts` | localStorage-backed implementations with simulated latency |
| `prayer.ts` | Prayer times per city and date (`adhan`), in the city's time zone |
| `data/sample.ts` | Madinah sample places (approximate; never loaded in production) |

### `@riflo/ui`

`Button`, `IconButton`, `Chip`, `StopCard` + `Leg` (the ticket), `Stamp`, `Stepper`, `Switch`, `ImageSlot`, `Sheet`, `Toast`, `EmptyState`, `ErrorState`, `Skeleton`, `Icon`, and the `useAsync` hook.

## The RIFLO Passport loop

- Creating a plan stores the preferences (minus dates) in `passport.lastPreferences`; the next trip opens pre-filled.
- "Use it again" on any past trip opens the planner with that trip's preferences (`/plan/new?from=<id>`).
- Logging a visit in the place sheet adds a `Visit` (stamp) and removes the place from the wish list.
- Saved places feed the planner ranking and the suggestions on Home and in the Passport.
- Rewards and partners are not built; `Passport` can take a `rewards` field later without touching existing screens.

## Accounts in the apps

- Guests can browse, explore and build a plan. Saving a trip, logging a visit or saving a place opens the sign-in sheet; after the code is confirmed the action continues where it left off.
- The admin is gated by `AdminGate`: only `editor` and `admin` accounts get in.
- The session lives in an HttpOnly cookie set by the API; page scripts never see it. A 401 makes the app fall back to guest mode, and a cookie whose session was revoked is cleared by the API on the next request.

## What's next

See [LAUNCH.md](LAUNCH.md) for external services (email, prayer times, photos, hosting) and deployment.
