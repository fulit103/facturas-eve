import { disableTool } from "eve/tools";

// Analysis goes through execute_js only; the model gets no raw shell or file access.
export default disableTool();
