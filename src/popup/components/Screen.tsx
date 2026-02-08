import React from "react";

export const Screen: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	return (
		<div className="h-full flex flex-col w-full overflow-y-auto">
			{children}
		</div>
	);
};
