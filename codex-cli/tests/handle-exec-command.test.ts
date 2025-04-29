import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppConfig } from "../src/utils/config";
import type { ApprovalPolicy } from "../src/approvals";
import type { ExecInput } from "../src/utils/agent/sandbox/interface";
import { SandboxType } from "../src/utils/agent/sandbox/interface";
import { ReviewDecision } from "../src/utils/agent/review";

// Mock setup - all mocks are defined before any imports
vi.mock("../src/utils/agent/exec", () => ({
  exec: vi
    .fn()
    .mockResolvedValue({ stdout: "mock stdout", stderr: "", exitCode: 0 }),
  execApplyPatch: vi
    .fn()
    .mockResolvedValue({ stdout: "patch applied", stderr: "", exitCode: 0 }),
}));

vi.mock("../src/approvals", () => ({
  canAutoApprove: vi.fn().mockReturnValue({
    type: "auto-approve",
    runInSandbox: false,
    applyPatch: undefined,
    reason: "Mocked auto-approval",
    group: "mock_group",
  }),
}));

// Mock fs/promises - important to include constants
vi.mock("fs/promises", () => {
  const accessMock = vi.fn().mockResolvedValue(undefined);
  return {
    default: {
      access: accessMock,
      constants: {
        F_OK: 0,
        R_OK: 4,
        W_OK: 2,
        X_OK: 1,
      },
    },
    access: accessMock,
    constants: {
      F_OK: 0,
      R_OK: 4,
      W_OK: 2,
      X_OK: 1,
    },
  };
});

vi.mock("../src/utils/logger/log", () => ({
  log: vi.fn(),
  isLoggingEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/utils/agent/sandbox/macos-seatbelt", () => ({
  PATH_TO_SEATBELT_EXECUTABLE: "/usr/bin/sandbox-exec",
}));

// Import after all mocks are defined
import { handleExecCommand } from "../src/utils/agent/handle-exec-command.js";
import { exec } from "../src/utils/agent/exec.js";
import { canAutoApprove } from "../src/approvals.js";
import { access } from "fs/promises";

describe("handleExecCommand", () => {
  let mockConfig: AppConfig;
  let mockPolicy: ApprovalPolicy;
  let mockExecInput: ExecInput;
  let mockGetCommandConfirmation: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      model: "test-model",
      instructions: "test-instructions",
      tools: {
        shell: {
          maxBytes: 1024,
          maxLines: 100,
        },
      },
      fullAutoErrorMode: undefined,
    };

    mockPolicy = "full-auto";
    mockExecInput = {
      cmd: ["test-command"],
      workdir: "/test/dir",
      timeoutInMillis: 5000,
    };

    mockGetCommandConfirmation = vi.fn().mockResolvedValue({
      review: ReviewDecision.YES,
      customDenyMessage: "",
    });

    // Reset mocks for each test
    vi.mocked(canAutoApprove).mockReturnValue({
      type: "auto-approve",
      runInSandbox: false,
      applyPatch: undefined,
      reason: "Mocked auto-approval",
      group: "mock_group",
    });

    vi.mocked(access).mockClear();
    vi.mocked(exec).mockClear();
  });

  it("should propagate AppConfig correctly to the exec function", async () => {
    // Execute the function under test
    await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      ["/additional/writable"],
      mockGetCommandConfirmation,
      undefined,
    );

    // Verify exec was called with the correct AppConfig
    const mockExec = vi.mocked(exec);
    expect(mockExec).toHaveBeenCalledTimes(1);

    // Verify the AppConfig was passed correctly to exec
    const execCallArgs = mockExec.mock.calls[0];
    expect(execCallArgs).toBeDefined();

    // Make sure we have the exec call arguments
    if (!execCallArgs) {
      throw new Error("exec was not called");
    }

    // The AppConfig should be the 3rd parameter to exec (index 2)
    const passedConfig = execCallArgs[2] as AppConfig;
    expect(passedConfig).toBeDefined();

    // Check the config object equality
    expect(passedConfig).toEqual(mockConfig);

    // Check specific properties to ensure they're properly passed
    expect(passedConfig.model).toBe(mockConfig.model);
    expect(passedConfig.instructions).toBe(mockConfig.instructions);
    expect(passedConfig.tools?.shell?.maxBytes).toBe(
      mockConfig.tools?.shell?.maxBytes,
    );
    expect(passedConfig.tools?.shell?.maxLines).toBe(
      mockConfig.tools?.shell?.maxLines,
    );

    // Also verify the input parameters are correct
    const passedExecInput = execCallArgs[0];
    expect(passedExecInput).toEqual({
      ...mockExecInput,
      additionalWritableRoots: ["/additional/writable"],
    });

    // Verify the sandbox type is correct
    const passedSandboxType = execCallArgs[1];
    expect(passedSandboxType).toBe(SandboxType.NONE);
  });
});
