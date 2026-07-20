import * as React from "react";
import { createComponent } from "@lit/react";
import { Menu as UrMenuElement } from "../../components/menu/menu.js";

// Create the React component wrapper
export const Menu = createComponent({
	tagName: "ur-menu",
	elementClass: UrMenuElement,
	react: React,
	events: {
		onUrMenuClose: "ur-menu-close",
	},
});

export interface MenuProps {
	open?: boolean;
	onUrMenuClose?: (e: Event) => void;
	children?: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

// Typed wrapper component
export const UrMenu = React.forwardRef<UrMenuElement, MenuProps>(
	(props, ref) => {
		return <Menu ref={ref} {...props} />;
	},
);

UrMenu.displayName = "UrMenu";

export { UrMenuElement };
export default UrMenu;
