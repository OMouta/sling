import { useNavigate } from "@tanstack/react-router";
import { CloudOff, RotateCw } from "lucide-react";
import { Button, Empty } from "./ui.tsx";

/**
 * What a page shows when it fails to load or render, such as a page of an
 * older build that is no longer on the server. Reloading gets the current one.
 */
export function RouteError() {
  return (
    <Empty
      fill
      title="This page didn't load"
      action={
        <Button variant="primary" icon={RotateCw} onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  );
}

/** An address with no page. */
export function NotFound() {
  const navigate = useNavigate();
  return (
    <Empty
      fill
      title="Page not found"
      action={
        <Button variant="primary" onClick={() => void navigate({ to: "/" })}>
          Go home
        </Button>
      }
    />
  );
}

/** A list that couldn't load, in place of the list, with a way to try again. */
export function LoadFailed({
  title,
  retry,
  retrying,
}: {
  title: string;
  retry: () => void;
  retrying: boolean;
}) {
  return (
    <Empty
      fill
      icon={CloudOff}
      title={title}
      action={
        <Button icon={RotateCw} busy={retrying} onClick={retry}>
          Try again
        </Button>
      }
    />
  );
}
