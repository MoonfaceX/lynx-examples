import { root } from "@lynx-js/react";
import "./index.scss";

const BorderBottomColor = () => {
  return (
    <view className="intro">
      <text className="border-color">
        {"\n border-left-color: red; \n border-right-color: blue; \n border-top-color: green; \n border-bottom-color: black; \n"}
      </text>
    </view>
  );
};

root.render(<BorderBottomColor />);
