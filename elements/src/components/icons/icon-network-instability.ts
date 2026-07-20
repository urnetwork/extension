import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { iconBaseStyles } from "./icon-base.styles";
import { iconNetworkInstabilityStyles } from "./icon-network-instability.styles";

// from Streamline Icons -  https://www.streamlinehq.com/icons/pixel?search=cloud&icon=ico_Urk2YfKnCO0AhZfq
@customElement("ur-icon-network-instability")
export class IconNetworkInstability extends LitElement {
	static styles = [iconBaseStyles, iconNetworkInstabilityStyles];

	@property({ type: String }) iconTitle?: string;

	render() {
		return html`
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 32 32"
				id="Internet-Network-Cloud-Error--Streamline-Pixel"
				aria-hidden=${this.title ? "false" : "true"}
				role=${this.title ? "img" : "presentation"}
			>
				${this.title ? html`<title>${this.title}</title>` : ""}
				<desc>
					Internet Network Cloud Error Streamline Icon: https://streamlinehq.com
				</desc>
				<title>internet-network-cloud-error</title>
				<g>
					<path
						d="M30.47 16.005H32v6.09h-1.53Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M28.95 22.095h1.52v1.53h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M28.95 14.475h1.52v1.53h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M27.43 23.625h1.52v1.52h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M27.43 12.955h1.52v1.52h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M3.05 25.145h24.38v1.52H3.05Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M24.38 11.435h3.05v1.52h-3.05Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M22.85 9.905h1.53v1.53h-1.53Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M21.33 17.525h1.52v1.52h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M21.33 14.475h1.52v1.53h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M21.33 8.385h1.52v1.52h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M19.81 16.005h1.52v1.52h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M18.28 17.525h1.53v1.52h-1.53Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M18.28 14.475h1.53v1.53h-1.53Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M18.28 6.855h3.05v1.53h-3.05Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="m13.71 22.095 3.05 0 0 1.53 3.05 0 0 -3.05 -6.1 0 0 1.52z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M13.71 5.335h4.57v1.52h-4.57Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M12.19 17.525h1.52v1.52h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M12.19 14.475h1.52v1.53h-1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M10.66 6.855h3.05v1.53h-3.05Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M10.66 16.005h1.53v1.52h-1.53Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M9.14 17.525h1.52v1.52H9.14Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M9.14 14.475h1.52v1.53H9.14Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M9.14 8.385h1.52v1.52H9.14Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M7.62 9.905h1.52v3.05H7.62Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M3.05 12.955h4.57v1.52H3.05Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M1.52 23.625h1.53v1.52H1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M1.52 14.475h1.53v1.53H1.52Z"
						fill="currentColor"
						stroke-width="1"
					></path>
					<path
						d="M0 16.005h1.52v7.62H0Z"
						fill="currentColor"
						stroke-width="1"
					></path>
				</g>
			</svg>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"ur-icon-network-instability": IconNetworkInstability;
	}
}
