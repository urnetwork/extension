import * as React from "react";
import { createComponent } from "@lit/react";
import { MenuButton as UrMenuButtonElement } from "../../components/menu/menu-button.js";

// Create the React component wrapper
export const MenuButton = createComponent({
	tagName: "ur-menu-button",
	elementClass: UrMenuButtonElement,
	react: React,
	events: {},
});

export interface MenuButtonProps {
	children?: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

// Typed wrapper component
export const UrMenuButton = React.forwardRef<
	UrMenuButtonElement,
	MenuButtonProps
>((props, ref) => {
	return <MenuButton ref={ref} {...props} slot="button" />;
});

UrMenuButton.displayName = "UrMenuButton";

export { UrMenuButtonElement };
export default UrMenuButton;
