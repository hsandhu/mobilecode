import type { ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="0"
        y="106"
        fill="currentColor"
        opacity="0.6"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="118"
        font-weight="700"
        textLength="720"
        lengthAdjust="spacingAndGlyphs"
      >
        mobilecode
      </text>
    </svg>
  )
}
