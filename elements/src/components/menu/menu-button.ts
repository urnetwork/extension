import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { menuButtonStyles } from "./menu-button.styles";

@customElement("ur-menu-button")
export class MenuButton extends LitElement {
	static styles = menuButtonStyles;

	render() {
		return html`
			<button class="button" part="button">
				<slot></slot>
			</button>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-menu-button": MenuButton;
	}
}
