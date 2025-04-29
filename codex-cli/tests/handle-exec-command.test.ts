import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as execModule from "../src/utils/agent/exec"; // Import the module to mock
import * as approvalsModule from "../src/approvals"; // Import the module to mock canAutoApprove
import * as fsPromises from "fs/promises";
import type { AppConfig } from "../src/utils/config";
import type { ApprovalPolicy, SafetyAssessment } from "../src/approvals";
import type { ExecInput } from "../src/utils/agent/sandbox/interface";
import { SandboxType } from "../src/utils/agent/sandbox/interface";
import { ReviewDecision } from "../src/utils/agent/review";
import type { CommandConfirmation } from "../src/utils/agent/agent-loop";

// --- Mocking setup ---
const mockedIsInLinux: Mock<() => Promise<boolean>> = vi
  .fn()
  .mockResolvedValue(false);

// Mock dependencies
vi.mock("../src/utils/agent/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof execModule>();
  return {
    ...actual,
    exec: vi
      .fn()
      .mockResolvedValue({ stdout: "mock stdout", stderr: "", exitCode: 0 }),
    // Mock execApplyPatch if needed for specific tests
    execApplyPatch: vi
      .fn()
      .mockResolvedValue({ stdout: "patch applied", stderr: "", exitCode: 0 }),
  };
});

vi.mock("../src/approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof approvalsModule>();
  return {
    ...actual,
    canAutoApprove: vi.fn().mockReturnValue({
      type: "auto-approve",
      runInSandbox: false,
      applyPatch: undefined,
      reason: "Mocked auto-approval",
      group: "mock_group",
    } as SafetyAssessment),
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined), // Mock access to succeed
  };
});

// Mock logger to prevent console output during tests
vi.mock("../src/utils/logger/log", () => ({
  log: vi.fn(),
  isLoggingEnabled: vi.fn().mockReturnValue(false),
}));

// Mock parts of handle-exec-command (only isInLinux) - Revert to simpler mock
vi.mock("../src/utils/agent/handle-exec-command", async () => {
  // Let TypeScript infer the type of 'actual'
  const actual = await import("../src/utils/agent/handle-exec-command");
  return {
    ...actual,
    isInLinux: mockedIsInLinux, // Only override isInLinux
  };
});

// Import the potentially mocked module *after* vi.mock calls
const handleExecCommandModule = await import(
  "../src/utils/agent/handle-exec-command"
);
const handleExecCommand = handleExecCommandModule.handleExecCommand;

// --- End Mocking Setup ---

describe("handleExecCommand", () => {
  let mockConfig: AppConfig;
  let mockPolicy: ApprovalPolicy;
  let mockExecInput: ExecInput;
  let mockGetCommandConfirmation: Mock<
    (
      command: Array<string>,
      applyPatch: approvalsModule.ApplyPatchCommand | undefined,
    ) => Promise<CommandConfirmation>
  >;

  const mockedExec = vi.mocked(execModule.exec);
  const mockedCanAutoApprove = vi.mocked(approvalsModule.canAutoApprove);
  const mockedFsAccess = vi.mocked(fsPromises.access);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsInLinux.mockClear().mockResolvedValue(false);

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
    // Default input (can be used by tests not sensitive to 'always approved' state)
    mockExecInput = {
      cmd: ["default-cmd"],
      workdir: "/test/dir",
      timeoutInMillis: 5000,
    };
    mockGetCommandConfirmation = vi.fn().mockResolvedValue({
      review: ReviewDecision.YES,
      customDenyMessage: "",
    });

    mockedCanAutoApprove.mockReturnValue({
      type: "auto-approve",
      runInSandbox: false,
      applyPatch: undefined,
      reason: "Mocked auto-approval",
      group: "mock_group",
    } as SafetyAssessment);
    mockedExec.mockResolvedValue({
      stdout: "mock stdout",
      stderr: "",
      exitCode: 0,
    });
    mockedFsAccess.mockResolvedValue(undefined);
  });

  it("should propagate AppConfig correctly to the exec function", async () => {
    await handleExecCommand(
      mockExecInput,
      mockConfig,
      mockPolicy,
      ["/additional/writable"],
      mockGetCommandConfirmation,
      undefined,
    );

    expect(mockedFsAccess).toHaveBeenCalledWith(mockExecInput.workdir);

    expect(mockedCanAutoApprove).toHaveBeenCalledWith(
      mockExecInput.cmd,
      mockExecInput.workdir,
      mockPolicy,
      [expect.any(String)],
    );

    expect(mockedExec).toHaveBeenCalledTimes(1);

    const execCallArgs = mockedExec.mock.calls[0];
    expect(execCallArgs).toBeDefined();

    const passedExecInput = execCallArgs![0];
    const passedSandboxType = execCallArgs![1];
    const passedAbortSignal = execCallArgs![2];
    const passedConfig = execCallArgs![3];

    expect(passedConfig).toBeDefined();
    expect(passedConfig).toMatchObject(mockConfig);
    expect(passedConfig?.tools?.shell?.maxBytes).toBe(
      mockConfig.tools?.shell?.maxBytes,
    );
    expect(passedConfig?.tools?.shell?.maxLines).toBe(
      mockConfig.tools?.shell?.maxLines,
    );

    expect(passedExecInput).toEqual({
      ...mockExecInput,
      additionalWritableRoots: ["/additional/writable"],
    });
    expect(passedSandboxType).toBe(SandboxType.NONE);
    expect(passedAbortSignal).toBeUndefined();
  });
});
