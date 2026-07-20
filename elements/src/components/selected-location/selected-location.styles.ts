import { css } from "lit";

export const selectedLocationStyles = css`
	:host {
		width: 100%;
		box-sizing: border-box;
	}

	.location-list-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		box-sizing: border-box;
		padding: var(--ur-space-sm) 0;
	}

	.leading-list-item-content {
		display: flex;
		align-items: center;
	}

	.location-text-content {
		display: flex;
		flex-flow: column;
		align-items: start;
	}

	.selected-icon {
		width: 1.6rem;
		height: 1.6rem;
		margin-right: 0.3rem;
	}
`;
