# UI kit on React Aria Components

The web app uses browser-native `<select>`, checkbox, radio, date and time inputs in about 15 files. They look different in every browser, ignore our tokens and dark theme (ADR 0008), can't show an icon or a description per item, and can't be searched. A native date input can't show a Buddhist-era year. Choosing a model, a Team Role, a person, a Feature or a time zone needs a searchable list, and Delegation, holidays, Quiet Hours and the stats range need a date and time picker that works in Thai.

We build our own **UI kit** on **`react-aria-components`** (Adobe's headless React Aria), styled with our Tailwind tokens:

- **Headless.** React Aria gives the behaviour, focus handling and ARIA. We write every style with the ADR 0008 tokens, in light and dark.
- **Ours to change.** The components live in `apps/web/components/ui/`, in our code, not behind a package. Each wraps React Aria components with our styles and a small API, so changing a component means editing one file.
- **Accessibility and keyboard.** React Aria has the most complete keyboard and screen-reader support of the headless libraries, tested across browsers and screen readers. Select, ComboBox, DatePicker, Menu and Dialog follow the ARIA patterns.
- **Internationalized dates.** Its date components (on `@internationalized/date`) support the Thai locale, the Buddhist calendar and time zones, which Thai teams expect and native inputs can't do.

## Rejected

- **Radix UI.** Good primitives and widely used, but it has no ComboBox and no date or time picker, so we would add other libraries for exactly the parts we need most, each behaving differently.
- **Base UI.** From much of the Radix team and promising, but younger, and without the date and calendar components we need.
- **A styled kit (MUI, Mantine, Ant Design).** Its look fights ADR 0008, re-theming it is harder than styling a headless component, and its code isn't ours to change.
- **Keep native controls.** Free and accessible, but unstyled, unsearchable, and without Buddhist-era dates.

## Consequences

- A somewhat larger client bundle than Radix or native controls. Accepted: components are imported one by one, and the date code loads only on pages with a picker.
- New forms use the kit. A test fails if a native `<select>`, date or time input appears in `apps/web`.
- A dev-only gallery at `/dev/ui` shows every component in both themes, for review and for accessibility tests.
