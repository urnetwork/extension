import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { backBtnStyles } from "./back-button.styles";
import "../icons/icon-back";

@customElement("ur-back-button")
export class BackButton extends LitElement {
	@property({ type: Function }) onClick?: (e: MouseEvent) => void;

	@property({ type: String }) label: string = "Back";

	static styles = backBtnStyles;

	private _handleClick(e: MouseEvent) {
		if (this.onClick) {
			this.onClick(e);
		}
	}

	render() {
		return html`
			<button @click=${this._handleClick}>
				<ur-icon-back></ur-icon-back>
				<span style="padding-top: 0.125rem"> ${this.label} </span>
			</button>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-back-button": BackButton;
	}
}
