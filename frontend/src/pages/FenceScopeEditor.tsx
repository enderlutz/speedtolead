import { useParams } from "react-router-dom";
import FenceScopeEditorPanel from "@/components/FenceScopeEditor";

// The editor draws its own header (customer, address, save state, Send), so
// this page is just the full-height frame it lives in. The shell above is a
// flex column, so h-full here is the room left under the phone header.
export default function FenceScopeEditorPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return (
    <div className="h-full min-h-0">
      <FenceScopeEditorPanel leadId={id} />
    </div>
  );
}
