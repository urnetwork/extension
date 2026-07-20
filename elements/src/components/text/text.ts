import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeStatic, html as staticHtml } from "lit/static-html.js";
import { textStyles } from "./text.styles";

export const TEXT_VARIANTS = ["header", "subheader", "body", "small"] as const;
export type TextVariant = (typeof TEXT_VARIANTS)[number];

@customElement("ur-text")
export class Text extends LitElement {
	@property({ type: String, reflect: true })
	variant: TextVariant = "body";

	@property({ type: String })
	color?: string;

	@property({ type: Boolean, reflect: true })
	bold: boolean = false;

	@property({ type: Boolean, reflect: true })
	italic: boolean = false;

	@property({ type: String, reflect: true })
	align?: "left" | "center" | "right";

	static styles = textStyles;

	// Map variants to semantic HTML tags
	private getElementTag(): string {
		switch (this.variant) {
			case "header":
				return "h1";
			case "subheader":
				return "h2";
			case "small":
				return "small";
			case "body":
			default:
				return "p";
		}
	}

	render() {
		const tag = unsafeStatic(this.getElementTag());
		const styles = this.color ? `color: ${this.color};` : "";

		return staticHtml`<${tag} class="text" style="${styles}"><slot></slot></${tag}>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-text": Text;
	}
}
