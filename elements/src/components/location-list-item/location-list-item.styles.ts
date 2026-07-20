import { css } from "lit";

export const locationListStyles = css`
	:host {
		display: list-item;
		width: 100%;
		box-sizing: border-box;
	}

	.location-list-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		min-height: 3.6rem;
		box-sizing: border-box;
		padding: var(--ur-space-sm) var(--ur-space-md);
		cursor: pointer;
		transition: background-color 0.15s;
	}

	:host(:not(:first-child)) .location-list-item {
		border-top: 1px solid var(--ur-color-border);
	}

	.location-list-item:hover {
		background-color: color-mix(
			in srgb,
			var(--ur-color-black, #101010),
			#fff 2%
		);
	}

	.leading-list-item-content {
		display: flex;
		align-items: center;
		/*flex-flow: column;*/
	}

	.location-text-content {
		display: flex;
		flex-flow: column;
		align-items: start;
	}

	.color-circle {
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 50%;
		margin-right: var(--ur-space-sm);
	}
`;
