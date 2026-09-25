# Converter issues

Defects found in converter output that the converter's own checks did not
report. Each entry lists the source, what the converter produced, the fix
applied to the saved output, and the rule the converter should follow.

## Summary

| # | Issue | Owner | Seen in |
| --- | --- | --- | --- |
| 1 | Root component dropped from the named exports | Converter | attachment, accordion, alert, alert-dialog |
| 2 | Hook call left inside a template interpolation | Converter | attachment; also `beast-converter/src/components/ui/button-group.btsx` |
| 3 | Base UI `useRender` typings don't carry over from React | `@octanejs/base-ui` (converter can work around) | attachment |
| 4 | ReUI's `IconPlaceholder` copied verbatim | Converter | accordion; 23 of 62 ReUI base components use it |
| — | Only the editor's language server type-checks `.btsx`; the converter and `tsrx-tsc` don't | Tooling | all runs |

## attachment.tsx → attachment.btsx

- Source: `keenthemes/reui@6e433dd`, `registry/bases/base/ui/attachment.tsx`
- Run: `output/00079d3d-ddf5-4fbb-a9bb-79c5dcd1f3c6`, remote converter
- Converter response: `ok: true`, Beast and Octane compilation `ok`, no
  diagnostics.

The saved output compiles with Beast, but type-checking the generated TSRX
reports three errors, one in a consumer and two in the file itself:

```text
consumer.tsrx(1,10): error TS2614: Module '"@/components/ui/attachment.tsrx"' has no exported member 'Attachment'.
attachment.tsrx(59,42): error TS2322: Type 'PropsOf<"button">' is not assignable to type 'Record<string, unknown> | undefined'.
attachment.tsrx(59,211): error TS2322: Type '… | ComponentRenderFn<HTMLProps, {}> | undefined' is not assignable to type 'UseRenderRenderProp<{ slot: string; }> | undefined'.
```

After the fix: 0 errors, including `AttachmentAction` checked against the
converter app's real `button.btsx`. A server render of `Attachment` with
`AttachmentTrigger` and `AttachmentAction` produces the expected markup (with a
stub `Button`, since the real one's `@octanejs/radix` dependency doesn't load
under Bun's server loader).

### 1. Root component dropped from the named exports

The source has no default export. Every part is a named export:

```tsx
export { Attachment, AttachmentGroup, AttachmentMedia, /* … */ AttachmentTrigger }
```

The converter makes `Attachment` the file's root, which Beast emits as
`export default function Attachment`, and then removes it from the named list:

```btsx
module
  export { AttachmentGroup, AttachmentMedia, /* … */ AttachmentTrigger };
```

So `import { Attachment } from "…/attachment"`, which the source supports,
fails with TS2614, and `export * from "./attachment.btsx"` barrels lose the
root. The same happens in `accordion`, `alert` and `alert-dialog` from the same
run (each source exports its root by name; each output drops it).

**Fix applied:** add the root back to the list. The default export stays, so
default imports still work.

```btsx
  export { Attachment, AttachmentGroup, AttachmentMedia, /* … */ AttachmentTrigger };
```

**Converter rule:** preserve the source module's export surface. If the source
exported the root component by name, keep that name in the `module` export
list. Beast names the root after the file (`attachment.btsx` → `Attachment`),
so this is only valid when the two agree; otherwise emit a `componentName`
for the root or choose a root whose name matches the filename. The converter
app already needs `componentName` overrides for `avatar`, `fluid-tooltip` and
`button-group` for this reason (see its `rspack.config.ts`).

### 2. Hook call left inside a template interpolation

The source returns a hook's result directly:

```tsx
function AttachmentTrigger({ className, render, type, ...props }: useRender.ComponentProps<"button">) {
  return useRender({ defaultTagName: "button", props: mergeProps<"button">(…), render, state: { slot: "attachment-trigger" } })
}
```

The converter turned the `return` into a text interpolation, so the hook is
called inside the template:

```btsx
component AttachmentTrigger
  props { className, render, type, ...props }: useRender.ComponentProps<"button">
  | #{useRender({
    ~ …
    ~ })
    ~ }
```

Octane compiles this without a diagnostic, but it does not give the hook a
slot. Compiled for the client, the interpolated call is emitted raw inside the
template's update code:

```js
const _v = useRender({ defaultTagName: "button", props });
```

while the same call in setup is lowered to a slotted hook:

```js
const element = _$withSlot(_h$0, useRender, { defaultTagName: "button", props });
```

`useRender` calls `useRenderElement`, which uses hooks, so its state is not
tied to a slot across client re-renders. Server rendering produced identical
HTML for both forms; client re-render behaviour was not tested. The Base UI
port's own components call `useRenderElement` in the component body and
return the result (for example `separator/Separator.tsrx`).

**Fix applied:** call the hook in `setup` and render its result.

```btsx
component AttachmentTrigger
  props { className, render, type, ...props }: useRender.ComponentProps<"button", {}, HTMLAttributes<HTMLButtonElement>>
  setup
    const element = useRender({ … });
  | #{element}
```

**Converter rule:** never leave a `use*` call inside `#{…}`. For
`return useX(…)`, emit `setup const element = useX(…);` followed by
`| #{element}`. The converter app's `button-group.btsx` (`ButtonGroupText`)
has the same pattern and should be regenerated or fixed the same way.

### 3. Base UI `useRender` typings don't carry over from React

Both errors on the `useRender` call come from `@octanejs/base-ui` types that
are compatible in React but not in Octane. The source code is correct React.

**a. `props: mergeProps<"button">(…)`**: `mergeProps` returns
`PropsOf<"button">`, an intersection of interfaces with no index signature,
while `useRender`'s `props` is typed `Record<string, unknown>`.

Fix applied: spread the merged props into an object literal, which TypeScript
accepts as a record.

```btsx
      props: {
        ...mergeProps<"button">({ … }, props),
      },
```

**b. `render`**: `useRender.ComponentProps<"button">` types `render` as
`ComponentRenderFn<HTMLProps, {}>`, but `useRender({ render })` expects
`ComponentRenderFn<HTMLAttributes<any>, State>`. The port's `HTMLProps`
narrows `style` to `CSSProperties` (its README: CSS text strings are not
accepted), while Octane's `HTMLAttributes` also allows a string `style`.
Render functions take props as a parameter, so the narrower one can't be
passed where the wider one is expected. In React both are the same shape,
because React's `style` is never a string.

Fix applied: declare the render function's props as `HTMLAttributes`, the
type `useRender` passes.

```btsx
  props { className, render, type, ...props }: useRender.ComponentProps<"button", {}, HTMLAttributes<HTMLButtonElement>>
```

(`HTMLAttributes` is imported from `octane`.)

**Upstream fix:** in `@octanejs/base-ui` `src/use-render/useRender.ts`, make
`UseRenderRenderProp` and `UseRenderComponentProps` use the same props type,
and let `UseRenderParameters.props` accept `mergeProps`' return type. Both
errors then disappear without changing converted code.

**Converter rule until then:** for Base UI `useRender` components, spread
`mergeProps(…)` into an object literal and pass `HTMLAttributes<Element>` as
the third type argument of `useRender.ComponentProps`.

### Not converter defects

- `import { cn } from "cn"` is verbatim from the ReUI registry, which uses
  `cn` as a placeholder the shadcn CLI rewrites. Map it with a tsconfig path
  or rewrite it for the target project.
- The source imports `@/registry/bases/base/ui/button`. The saved file now
  imports `{ Button }` from `@/components/ui`, which resolves where a
  `components/ui/index.ts` barrel re-exports the default-exported
  `button.btsx` by name.

## accordion.tsx → accordion.btsx

- Source: `keenthemes/reui@6e433dd`, `registry/bases/base/ui/accordion.tsx`
- Run: `output/00079d3d-ddf5-4fbb-a9bb-79c5dcd1f3c6`, remote converter
- Converter response: `ok: true`, no diagnostics.

Also affected by issue 1: `Accordion` was missing from the named exports.
Fixed the same way as in `attachment.btsx`.

### 4. ReUI's `IconPlaceholder` copied verbatim

The trigger's chevrons come from ReUI's icon placeholder, which lists the icon
for each library it supports:

```tsx
import { IconPlaceholder } from "@/app/(create)/components/icon-placeholder"

<IconPlaceholder
  lucide="ChevronDownIcon"
  tabler="IconChevronDown"
  hugeicons="ArrowDown01Icon"
  phosphor="CaretDownIcon"
  remixicon="RiArrowDownSLine"
  data-slot="accordion-trigger-icon"
  className="…"
/>
```

`@/app/(create)/components/icon-placeholder` is part of ReUI's own app, not the
registry components; each prop names the equivalent icon in one supported
library. The converter copied the import and both placeholders as they were,
so the output depends on a module no consuming project has.

**Fix applied:** a local `ChevronIcon` component inside the file, drawing the
lucide chevrons as inline SVG. Both uses keep their `data-slot` and classes:

```btsx
component ChevronIcon
  props { direction, ...props }: ComponentProps<"svg"> & { direction: "up" | "down" }
  svg(
    ~ xmlns="http://www.w3.org/2000/svg"
    ~ width="24"
    ~ height="24"
    ~ viewBox="0 0 24 24"
    ~ fill="none"
    ~ stroke="currentColor"
    ~ strokeWidth="2"
    ~ strokeLinecap="round"
    ~ strokeLinejoin="round"
    ~ aria-hidden="true"
    ~ {...props}
    ~ )
    path(d={direction === "up" ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"})
```

Octane maps `strokeWidth` and the other camelCase SVG attributes to their
hyphenated names, as React does. Verified: the language server reports no
diagnostics (it reported `Cannot find name 'Icon'` twice before), a consumer
importing all four parts type-checks, and a server render produces the SVGs
with the open item's trigger at `aria-expanded="true"`, which the existing
`group-aria-expanded/accordion-trigger:hidden` / `:inline` classes use to swap
the chevrons.

**Converter rule:** replace each `IconPlaceholder` with a local inline-SVG
component, using the icon named by its `lucide` prop, and drop the
`@/app/(create)/…` import. Pass the remaining props (`data-slot`, `className`,
…) through and drop the per-library props. All of ReUI's base components ask
for only 16 lucide icons (use count in parentheses), so a small table covers
them:

`CheckIcon` (11), `ChevronDownIcon` (7), `ChevronRightIcon` (6), `XIcon` (5),
`Loader2Icon` (3), `ChevronLeftIcon` (3), `TriangleAlertIcon` (2),
`OctagonXIcon` (2), `MoreHorizontalIcon` (2), `InfoIcon` (2),
`CircleCheckIcon` (2), `ChevronUpIcon` (2), `SearchIcon`, `PanelLeftIcon`,
`MinusIcon`, `ArrowDownIcon`.

Components that use the placeholder: toast, sonner, select, combobox,
pagination, dropdown-menu, context-menu, calendar, menubar, command, carousel,
breadcrumb, accordion, spinner, sidebar, sheet, questionnaire,
navigation-menu, native-select, message-scroller, input-otp, dialog,
checkbox.

Alternatively, when the target project has an icon package (for example
`@hugeicons/core-free-icons` in this repo), the converter could map to that
package's names (the `hugeicons` prop), but inline SVG keeps each output
self-contained.

## Why the converter didn't report these errors

- The converter's compilation check confirms that Beast and Octane compile the
  output. It does not type-check, so all three errors pass as `ok`.
- `tsrx-tsc` does not type-check `.btsx` files: a `.btsx` containing
  `const broken: number = "nope"` passes `tsrx-tsc --noEmit`. `bun run
  typecheck` in this repo and the converter repo therefore skips all BTSX
  sources (confirmed with both repos' configs: the same error in a `.ts` file
  is reported). Only the generated `.tsrx` is checked.
- The Beast language server does type-check `.btsx`. The one bundled in the
  VS Code and Zed extension 0.3.1 (beast-language-server 0.2.0) reports both
  issue 3 errors on the original output and none on the fixed file. Inside
  `~` continuation blocks it can place a diagnostic on the wrong line: the
  `render` error is reported on the first `render` in the expression
  (`type: render ? …`), not on the `render,` property.
- This repo's tsconfig sets `"tsrx": { "compiler": "octane" }`, which makes
  `tsrx-tsc` fail with "Invalid TSRX compiler" on any `.tsrx` file. Type
  checking `.tsrx` needs `"octane/compiler/volar"`, as the converter repo uses.
- The converter depends on `beast-tsrx` 0.3.2; this project uses 0.4.3. The
  output compiles under both, so the version gap did not cause these errors,
  but aligning them avoids differences between the converter's check and
  consuming apps.

**Suggested converter check:** type-check the output, either by running the
Beast language server's diagnostics on the `.btsx` or by running `tsrx-tsc`
(with `octane/compiler/volar`) on the generated TSRX, against the Octane
packages and with unresolved app imports (`cn`, `@/…`) stubbed. Either would
have reported issue 3 directly. Issue 1 only shows
in a consumer, so the converter should also compare the source's export names
with the output's.

## Reproducing

1. Compile the BTSX with Beast: `beast compile attachment.btsx -o attachment.tsrx`.
   Keep the filename, since it names the root component.
2. In a project with `octane`, `@octanejs/base-ui`, `class-variance-authority`
   and `@tsrx/typescript-plugin` (the converter repo has all of them), add a
   tsconfig with the plugin, `"tsrx": { "compiler": "octane/compiler/volar" }`,
   `paths` for `@/*` and `cn`, a `components/ui/index.ts` barrel, and a
   consumer that imports `{ Attachment, AttachmentContent, AttachmentTitle }`.
3. Run `tsrx-tsc --noEmit -p .`. The original output reports the three errors
   above; the fixed output reports none.
