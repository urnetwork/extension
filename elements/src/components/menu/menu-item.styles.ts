import { css } from "lit";

export const menuItemStyles = css`
	:host {
		width: 100%;
		box-sizing: border-box;
		display: block;
	}

	.menu-item-content {
		width: 100%;
		padding: var(--ur-space-sm) var(--ur-space-md);
		cursor: pointer;
		display: block;
	}

	:host(:hover) .menu-item-content {
		background-color: color-mix(
			in srgb,
			var(--ur-color-black, #101010),
			#fff 9%
		);
	}

	:host(:not(:last-child)) {
		border-bottom: 1px solid var(--ur-color-border, rgba(255, 255, 255, 0.1));
	}
`;
