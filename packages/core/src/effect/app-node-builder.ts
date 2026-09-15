import { buildLocationServiceMap } from "../location-services"
import { LocationServiceMap } from "../location-service-map"
import { LayerNode } from "./layer-node"
import { makeGlobalNode } from "./app-node"
import { WorkspaceProvider } from "../workspace-provider"

export function build<A, E>(
  root: LayerNode.Node<A, E, any>,
  replacements: LayerNode.Replacements = [],
  workspaces?: WorkspaceProvider.Interface,
) {
  let allReplacements = replacements

  // Only build the location service map if it's actually needed
  if (LayerNode.hasUnbound(root, LocationServiceMap.node) && !hasReplacement(replacements, LocationServiceMap.node)) {
    const locationMap = buildLocationServiceMap(replacements, workspaces)
    const locationMapNode = makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })
    allReplacements = replacements.concat([[LocationServiceMap.node, locationMapNode]])
  }

  return LayerNode.compile(root, allReplacements)
}

function hasReplacement(replacements: LayerNode.Replacements, node: LayerNode.Node<unknown, unknown, any>) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder"
