import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { menuItemStyles } from "./menu-item.styles";

@customElement("ur-menu-item")
export class MenuItem extends LitElement {
	static styles = menuItemStyles;

	@property({ type: Boolean })
	disabled = false;

	private _handleClick = (e: Event) => {
		if (this.disabled) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		this.dispatchEvent(
			new CustomEvent("ur-menu-item-click", {
				bubbles: true,
				composed: true,
				detail: { target: this },
			}),
		);
	};

	render() {
		return html`
			<div class="menu-item-content" @click=${this._handleClick}>
				<slot></slot>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-menu-item": MenuItem;
	}
}
