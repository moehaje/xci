import React from "react";
import { Box, Text } from "ink";

export type AppProps = {
  title?: string;
};

export function App({ title = "XCI" }: AppProps): JSX.Element {
  return (
    <Box flexDirection="column" padding={1}>
      <Text>{title}</Text>
      <Text>Startup scaffolding in place.</Text>
    </Box>
  );
}
