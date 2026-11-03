# AnyWear Client

Welcome to the **AnyWear Client** repository. This is the frontend application for the AnyWear ecosystem, targeting both Desktop and Mobile platforms using a single codebase.

See [DESIGN.md](DESIGN.md) for the current UI's source-grounded visual reference, component variants/states, responsive behavior, and known accessibility gaps. Update it alongside relevant UI changes.

## 🚀 Tech Stack

- **Framework**: [Tauri v2](https://v2.tauri.app/)
- **UI Library**: [React 19](https://react.dev/)
- **Language**: [TypeScript 5](https://www.typescriptlang.org/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **State Management**: [Zustand](https://zustand-demo.pmnd.rs/) (Global) & [TanStack Query v5](https://tanstack.com/query/latest) (Server State)
- **API Client**: [Axios](https://axios-http.com/) (Models and endpoints auto-generated via [Orval](https://orval.dev/))

## 📦 Getting Started

### Prerequisites

Ensure you have the following installed:
- [Node.js](https://nodejs.org/)
- [pnpm](https://pnpm.io/) (Strictly use `pnpm` for all dependency management)
- [Rust](https://www.rust-lang.org/) (Required for Tauri)
- Any OS-specific dependencies required by Tauri (see [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/))

### Installation

1. Clone the repository (make sure to initialize submodules if applicable):
   ```bash
   git clone --recurse-submodules <repository-url>
   cd AnyWear-Client
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

## 🛠️ Scripts & Commands

- `pnpm dev` - Run the development server (Web)
- `pnpm tauri dev` - Run the Tauri Desktop application
- `pnpm build` - Compile TypeScript and build the Vite project for production
- `pnpm tsc --noEmit` - Run strictly type checking (no emit)
- `pnpm orval` - Regenerate the API client from the OpenAPI spec. **Must be run after any changes to `api/anywear_openapi.yaml`.**

### Testing
- `pnpm test` - Run tests in watch mode
- `pnpm test:run` - Run Vitest tests and the explicitly listed build-identity/publication Node tests once
- `pnpm test:browser` - Run Client-owned Playwright browser integration tests with mocked service boundaries
  - **Important:** Before running browser tests for the first time, install Chromium with `pnpm exec playwright install chromium`.
  - Scenarios mock API/image/upload boundaries and fail unexpected external calls; the test server fixes the API origin to localhost:3000.
  - `AnyWear-E2E` owns the cross-repository system test pipeline and versioned compatibility pins.

### Workflow entries

Client exposes two workflow entries: `check.yml` runs automatically on push and pull
request to `main`, and `release.yml` is the one manual dispatch surface, offering the
single `operation: deploy`. `build.yml`, `test.yml` and `browser.yml` are
`workflow_call` implementations of `check.yml`, not entries.

| Entry | Trigger | Manual | Purpose |
| --- | --- | --- | --- |
| [`check.yml`](.github/workflows/check.yml) | push / pull request to `main` | no | Build, unit tests, mocked browser integration |
| [`release.yml`](.github/workflows/release.yml) | `workflow_dispatch` (`operation: deploy`) | yes | Build, verify, deploy and record the Beta web client |

### Beta web publication

See the [Beta publication runbook](docs/beta-web-publication.md) for the dedicated
Client role, the declared interface inputs, the build/verify/deploy/record chain, and
the deployment evidence produced by `release.yml`.

### Source CI credentials

See the [source CI credentials](docs/source-ci-credentials.md) note for the single
App credential the source workflows hold, the repositories it may read, and what
happens when it is unavailable.

## 🏗️ Project Structure

- `src/api/`: API integration layer. Includes auto-generated models and endpoints from Orval, and a custom Axios instance (`custom-instance.ts`).
- `src/components/`: Reusable, generic UI components (buttons, modals, inputs).
- `src/layouts/`: Global wrapper components (e.g., `AuthLayout`, `MainLayout`).
- `src/pages/`: Route-specific page components (grouped by feature).
- `src/store/`: Zustand state management stores (e.g., `authStore.ts`).
- `src-tauri/`: Rust backend specifically for Tauri desktop/mobile system bindings.
- `api/`: Git submodule containing the single-source-of-truth OpenAPI spec.

## 🔗 Related Repositories

- **AnyWear-Service**: The backend service (Node.js/Hono/Drizzle).
- **AnyWear-E2E**: Cross-repository Playwright system tests.
- **api**: A Git submodule utilized by this application for metadata management (OpenAPI definitions).
