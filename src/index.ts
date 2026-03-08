#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ethers } from "ethers";

// AgentFund Escrow Contract on Base Mainnet
const CONTRACT_ADDRESS = "0x6a4420f696c9ba6997f41dddc15b938b54aa009a";
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// Contract ABI - includes all read and write operations needed
const ABI = [
  "function createProject(address agent, uint256[] milestoneAmounts) external payable returns (uint256)",
  "function releaseMilestone(uint256 projectId) external",
  "function cancelProject(uint256 projectId) external",
  "function getProject(uint256 projectId) external view returns (tuple(address funder, address agent, uint256 totalAmount, uint256 releasedAmount, uint256 currentMilestone, uint256 totalMilestones, uint8 status))",
  "function projectCount() external view returns (uint256)",
  "event ProjectCreated(uint256 indexed projectId, address indexed funder, address indexed agent, uint256 totalAmount)",
  "event MilestoneReleased(uint256 indexed projectId, uint256 milestoneIndex, uint256 amount)"
];

const ProjectStatus = ["Active", "Completed", "Cancelled"];

class AgentFundMCPServer {
  private server: Server;
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  // Signer is optional - only available if PRIVATE_KEY env var is set
  // WHY: read-only tools work without a key; write tools require one
  private signer: ethers.Wallet | null = null;
  private signerContract: ethers.Contract | null = null;

  constructor() {
    this.server = new Server(
      { name: "agentfund-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    this.provider = new ethers.JsonRpcProvider(BASE_RPC);
    // Read-only contract instance used for all view calls
    this.contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, this.provider);

    // WHY: If PRIVATE_KEY is provided we set up a signer so the agent can
    // actually submit transactions (createProject, releaseMilestone, etc.)
    if (process.env.PRIVATE_KEY) {
      this.signer = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
      this.signerContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, this.signer);
    }

    this.setupHandlers();
  }

  private setupHandlers() {
    // ---- List available tools ------------------------------------------------
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "agentfund_get_project",
          description:
            "Get details of an AgentFund project by ID. Returns funder address, agent address, total/released amounts, milestone progress, and status (Active/Completed/Cancelled).",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "The project ID number" }
            },
            required: ["projectId"]
          }
        },
        {
          name: "agentfund_get_stats",
          description:
            "Get AgentFund platform statistics - total projects created and contract address.",
          inputSchema: { type: "object", properties: {} }
        },
        {
          name: "agentfund_find_my_projects",
          description:
            "Find all AgentFund projects where a specific address is the agent (recipient). Use this to find projects you're fundraising for.",
          inputSchema: {
            type: "object",
            properties: {
              agentAddress: {
                type: "string",
                description: "Your wallet address to search for"
              }
            },
            required: ["agentAddress"]
          }
        },
        {
          name: "agentfund_create_fundraise",
          description:
            "Create a new AgentFund project on-chain. Requires PRIVATE_KEY env var to be set so the agent wallet can sign and pay gas. The agent address receives the milestone funds; the signing wallet is the funder. Returns the new projectId.",
          inputSchema: {
            type: "object",
            properties: {
              agentAddress: {
                type: "string",
                description: "Wallet address that will receive the milestone payments"
              },
              milestoneAmountsEth: {
                type: "array",
                items: { type: "string" },
                description:
                  "Array of milestone amounts in ETH (e.g., ['0.01', '0.02', '0.01'])"
              },
              projectDescription: {
                type: "string",
                description: "Description of what will be delivered for the funding"
              }
            },
            required: ["agentAddress", "milestoneAmountsEth", "projectDescription"]
          }
        },
        {
          name: "agentfund_check_milestone",
          description:
            "Check the current milestone status of a project - how many milestones are done, how many remain, and the next milestone amount.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "The project ID number" }
            },
            required: ["projectId"]
          }
        },
        {
          name: "agentfund_generate_release_request",
          description:
            "Release the next milestone payment for a project. Requires PRIVATE_KEY env var (signer must be the funder). Returns the transaction hash.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "The project ID to release next milestone for" }
            },
            required: ["projectId"]
          }
        }
      ]
    }));

    // ---- Execute tool calls --------------------------------------------------
    // WHY: The CallToolRequestSchema handler is what was missing from the
    // original truncated file. Without it the MCP server lists tools but
    // silently does nothing when Claude (or any LLM) tries to call them.
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // ------------------------------------------------------------------
          case "agentfund_get_project": {
            const projectId = BigInt(args.projectId as string);
            const project = await this.contract.getProject(projectId);
            const status = ProjectStatus[Number(project[6])] ?? "Unknown";
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      projectId: args.projectId,
                      funder: project[0],
                      agent: project[1],
                      totalAmountEth: ethers.formatEther(project[2]),
                      releasedAmountEth: ethers.formatEther(project[3]),
                      currentMilestone: Number(project[4]),
                      totalMilestones: Number(project[5]),
                      status
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }

          // ------------------------------------------------------------------
          case "agentfund_get_stats": {
            const count = await this.contract.projectCount();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      contractAddress: CONTRACT_ADDRESS,
                      network: "Base Mainnet",
                      totalProjects: count.toString()
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }

          // ------------------------------------------------------------------
          case "agentfund_find_my_projects": {
            const agentAddress = (args.agentAddress as string).toLowerCase();
            const count = await this.contract.projectCount();
            const total = Number(count);
            const found: number[] = [];

            // WHY: We iterate all projects; for large sets a subgraph index
            // would be better, but this keeps the integration self-contained.
            for (let i = 1; i <= total; i++) {
              try {
                const p = await this.contract.getProject(i);
                if (p[1].toLowerCase() === agentAddress) {
                  found.push(i);
                }
              } catch (_) {
                // Skip any project that fails to decode
              }
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { agentAddress: args.agentAddress, projectIds: found, count: found.length },
                    null,
                    2
                  )
                }
              ]
            };
          }

          // ------------------------------------------------------------------
          // WHY: This is the core missing piece. The original code stopped
          // before implementing this handler. We now:
          //  1. Validate a signer exists (PRIVATE_KEY env var)
          //  2. Validate the signer has enough ETH to cover total + gas
          //  3. Submit createProject() and wait for confirmation
          //  4. Return the new projectId so the caller can verify on-chain
          case "agentfund_create_fundraise": {
            if (!this.signer || !this.signerContract) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: PRIVATE_KEY environment variable is required to create a project. Set it to the private key of the funder wallet."
                  }
                ],
                isError: true
              };
            }

            const agentAddress = args.agentAddress as string;
            const milestoneAmountsEth = args.milestoneAmountsEth as string[];
            const projectDescription = args.projectDescription as string;

            if (!milestoneAmountsEth || milestoneAmountsEth.length === 0) {
              return {
                content: [{ type: "text", text: "Error: milestoneAmountsEth must be a non-empty array" }],
                isError: true
              };
            }

            // Convert ETH strings to wei BigInt values
            const milestoneWei = milestoneAmountsEth.map((a) => ethers.parseEther(a));
            const totalWei = milestoneWei.reduce((acc, v) => acc + v, 0n);
            const totalEth = ethers.formatEther(totalWei);

            // WHY: Validate balance before sending to give a clear error
            // instead of a cryptic revert
            const balance = await this.provider.getBalance(this.signer.address);
            if (balance < totalWei) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Insufficient balance. Need ${totalEth} ETH but wallet ${this.signer.address} only has ${ethers.formatEther(balance)} ETH`
                  }
                ],
                isError: true
              };
            }

            // WHY: Estimate gas before submitting so we surface gas errors
            // cleanly rather than losing the transaction to a silent revert
            let gasEstimate: bigint;
            try {
              gasEstimate = await this.signerContract.createProject.estimateGas(
                agentAddress,
                milestoneWei,
                { value: totalWei }
              );
            } catch (e: any) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error estimating gas (likely contract revert): ${e.message}`
                  }
                ],
                isError: true
              };
            }

            // Submit the transaction with a 20% gas buffer
            const tx = await this.signerContract.createProject(
              agentAddress,
              milestoneWei,
              {
                value: totalWei,
                gasLimit: (gasEstimate * 120n) / 100n
              }
            );

            const receipt = await tx.wait();

            // WHY: Parse the ProjectCreated event to extract the projectId
            // returned by the contract rather than guessing or reading count()
            let projectId: string | null = null;
            if (receipt && receipt.logs) {
              const iface = new ethers.Interface(ABI);
              for (const log of receipt.logs) {
                try {
                  const parsed = iface.parseLog(log);
                  if (parsed && parsed.name === "ProjectCreated") {
                    projectId = parsed.args[0].toString();
                    break;
                  }
                } catch (_) {}
              }
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: true,
                      projectId,
                      txHash: receipt?.hash ?? tx.hash,
                      funder: this.signer.address,
                      agent: agentAddress,
                      totalAmountEth: totalEth,
                      milestones: milestoneAmountsEth.length,
                      description: projectDescription,
                      network: "Base Mainnet"
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }

          // ------------------------------------------------------------------
          case "agentfund_check_milestone": {
            const projectId = BigInt(args.projectId as string);
            const project = await this.contract.getProject(projectId);
            const current = Number(project[4]);
            const total = Number(project[5]);
            const remaining = total - current;
            const status = ProjectStatus[Number(project[6])] ?? "Unknown";

            // Per-milestone amount (uniform split stored in totalAmount)
            // WHY: The contract stores total and current index; per-milestone
            // amount is totalAmount / totalMilestones
            const perMilestone =
              total > 0 ? project[2] / BigInt(total) : 0n;

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      projectId: args.projectId,
                      status,
                      currentMilestone: current,
                      totalMilestones: total,
                      milestonesRemaining: remaining,
                      nextMilestoneAmountEth:
                        remaining > 0 ? ethers.formatEther(perMilestone) : null,
                      releasedAmountEth: ethers.formatEther(project[3]),
                      totalAmountEth: ethers.formatEther(project[2])
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }

          // ------------------------------------------------------------------
          // WHY: Release the next milestone so the agent receives payment.
          // Requires the signer to be the funder of the project.
          case "agentfund_generate_release_request": {
            if (!this.signer || !this.signerContract) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: PRIVATE_KEY environment variable is required to release a milestone."
                  }
                ],
                isError: true
              };
            }

            const projectId = BigInt(args.projectId as string);

            // Verify project exists and is active before submitting
            const project = await this.contract.getProject(projectId);
            const status = ProjectStatus[Number(project[6])] ?? "Unknown";
            if (status !== "Active") {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Project ${args.projectId} is ${status}, not Active. Cannot release milestone.`
                  }
                ],
                isError: true
              };
            }

            let gasEstimate: bigint;
            try {
              gasEstimate = await this.signerContract.releaseMilestone.estimateGas(projectId);
            } catch (e: any) {
              return {
                content: [
                  { type: "text", text: `Error estimating gas: ${e.message}` }
                ],
                isError: true
              };
            }

            const tx = await this.signerContract.releaseMilestone(projectId, {
              gasLimit: (gasEstimate * 120n) / 100n
            });
            const receipt = await tx.wait();

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: true,
                      projectId: args.projectId,
                      txHash: receipt?.hash ?? tx.hash,
                      milestoneReleased: Number(project[4]),
                      network: "Base Mainnet"
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }

          // ------------------------------------------------------------------
          default:
            return {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true
            };
        }
      } catch (error: any) {
        // WHY: Top-level catch ensures any unexpected error (network timeout,
        // ABI decode failure, etc.) surfaces as a readable MCP error rather
        // than crashing the server process.
        return {
          content: [
            {
              type: "text",
              text: `Error executing ${name}: ${error.message ?? String(error)}`
            }
          ],
          isError: true
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("AgentFund MCP Server running on stdio");
    console.error(`Contract: ${CONTRACT_ADDRESS} (Base Mainnet)`);
    console.error(`Signer: ${this.signer ? this.signer.address : "none (read-only mode)"}`);
  }
}

const server = new AgentFundMCPServer();
server.run().catch(console.error);
