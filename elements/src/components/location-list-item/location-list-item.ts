import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { locationListStyles } from "./location-list-item.styles";
import "../text";
import "../icons/icon-network-instability";
import "../icons/icon-privacy";
import { getColorHex } from "../../utils/color-utils";

@customElement("ur-location-list-item")
export class LocationListItem extends LitElement {
	static styles = locationListStyles;

	@property({ type: String }) locationKey!: string;
	@property({ type: String }) name: string = "";
	@property({ type: Number }) providerCount: number = 0;
	@property({ type: Boolean }) unstable: boolean = false;
	@property({ type: Boolean }) strongPrivacy: boolean = false;
	@property({ type: Function }) onClick?: () => void;

	private formatNumber(num: number): string {
		return num.toLocaleString("en-US");
	}

	render() {
		const color = this.locationKey ? getColorHex(this.locationKey) : "#000000";

		return html`
			<div class="location-list-item" @click=${this.onClick}>
				<div class="leading-list-item-content">
					<!-- color circle -->
					<div class="color-circle" style="background-color: ${color}"></div>

					<div class="location-text-content">
						<ur-text variant="body">${this.name}</ur-text>
						${this.providerCount > 0
							? html`
									<ur-text variant="small" color="var(--ur-color-gray)">
										${this.formatNumber(this.providerCount)}
										provider${this.providerCount === 1 ? "" : "s"}
									</ur-text>
								`
							: null}
					</div>
				</div>

				<div class="trailing-list-item-content">
					${this.unstable
						? html`
								<ur-icon-network-instability
									title="This location has network instability"
								></ur-icon-network-instability>
							`
						: null}
					${this.strongPrivacy
						? html`
								<ur-icon-privacy
									style="margin-left: 0.5rem;"
									title="This location offers strong privacy features"
								></ur-icon-privacy>
							`
						: null}
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-location-list-item": LocationListItem;
	}
}
