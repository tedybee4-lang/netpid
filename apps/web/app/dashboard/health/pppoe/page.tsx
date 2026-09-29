import FixTool from "@/components/FixTool";

export default function FixPppoePage() {
  return (
    <FixTool
      kind="pppoe"
      title="Fix PPPoE"
      description="PPPoE failures are almost always one of four things: the service is disabled, the RADIUS secret is wrong, the server is unreachable, or the pool is empty. Check them in that order."
    />
  );
}
