import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { menuStyles } from "./menu.styles";

@customElement("ur-menu")
export class Menu extends LitElement {
	static styles = menuStyles;

	@property({ type: Boolean, reflect: true })
	open = false;

	@query(".menu-button-slot")
	private _buttonSlot!: HTMLSlotElement;

	@query(".menu-items")
	private _menuItems!: HTMLElement;

	connectedCallback() {
		super.connectedCallback();
		document.addEventListener("click", this._handleDocumentClick);
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("click", this._handleDocumentClick);
	}

	private _handleButtonClick = (e: Event) => {
		e.stopPropagation();
		this.open = !this.open;

		if (this.open) {
			this._updatePosition();
		}
	};

	private _handleMenuClick = (e: Event) => {
		e.stopPropagation();
	};

	private _handleDocumentClick = () => {
		if (this.open) {
			this.open = false;
		}
	};

	private _handleMenuItemClick = (e: Event) => {
		// Auto-close menu when an item is clicked
		this.open = false;
	};

	private _updatePosition() {
		requestAnimationFrame(() => {
			if (!this._buttonSlot || !this._menuItems) return;

			const buttonElements = this._buttonSlot.assignedElements();
			if (buttonElements.length === 0) return;

			const button = buttonElements[0];
			const buttonRect = button.getBoundingClientRect();
			const menuRect = this._menuItems.getBoundingClientRect();

			// Position below and aligned to the left of the button
			let top = buttonRect.bottom + 8;
			let left = buttonRect.left;

			// Ensure menu stays within viewport
			const viewportWidth = window.innerWidth;
			const viewportHeight = window.innerHeight;

			// Adjust horizontal position if menu would overflow
			if (left + menuRect.width > viewportWidth - 8) {
				left = buttonRect.right - menuRect.width;
			}
			if (left < 8) {
				left = 8;
			}

			// Adjust vertical position if menu would overflow
			if (top + menuRect.height > viewportHeight - 8) {
				top = buttonRect.top - menuRect.height - 8;
			}

			this._menuItems.style.top = `${top}px`;
			this._menuItems.style.left = `${left}px`;
		});
	}

	render() {
		return html`
			<div class="menu-container">
				<div class="menu-button" @click=${this._handleButtonClick}>
					<slot name="button" class="menu-button-slot"></slot>
				</div>
				<div
					class="menu-items"
					@click=${this._handleMenuClick}
					@ur-menu-item-click=${this._handleMenuItemClick}
				>
					<slot></slot>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-menu": Menu;
	}
}
