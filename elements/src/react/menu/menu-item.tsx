import * as React from "react";
import { createComponent } from "@lit/react";
import { MenuItem as UrMenuItemElement } from "../../components/menu/menu-item.js";

// Create the React component wrapper
export const MenuItem = createComponent({
	tagName: "ur-menu-item",
	elementClass: UrMenuItemElement,
	react: React,
	events: {
		onMenuItemClick: "ur-menu-item-click",
	},
});

export interface MenuItemProps {
	disabled?: boolean;
	onMenuItemClick?: (e: Event) => void;
	children?: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

// Typed wrapper component
export const UrMenuItem = React.forwardRef<UrMenuItemElement, MenuItemProps>(
	(props, ref) => {
		return <MenuItem ref={ref} {...props} />;
	},
);

UrMenuItem.displayName = "UrMenuItem";

export { UrMenuItemElement };
export default UrMenuItem;
