import { createSingleFlight } from "../lib/singleFlight";

// Test plan U8 — a double tap sends one request.
describe("createSingleFlight", () => {
  it("a second tap while the first call runs gets the same promise and makes no second call", async () => {
    const sf = createSingleFlight();
    let release!: (v: string) => void;
    const call = jest.fn(() => new Promise<string>((r) => { release = r; }));
    const a = sf.run("join:m1", call);
    const b = sf.run("join:m1", call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sf.busy("join:m1")).toBe(true);
    release("pending");
    await expect(a).resolves.toBe("pending");
    await expect(b).resolves.toBe("pending");
    expect(sf.busy("join:m1")).toBe(false);
  });

  it("the key is free again after a failure, so a deliberate retry is possible", async () => {
    const sf = createSingleFlight();
    const call = jest.fn().mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValueOnce("accepted");
    await expect(sf.run("join:m1", call)).rejects.toThrow("Network request failed");
    await expect(sf.run("join:m1", call)).resolves.toBe("accepted");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("different actions or games do not block each other", async () => {
    const sf = createSingleFlight();
    const call = jest.fn(async () => 1);
    await Promise.all([sf.run("join:m1", call), sf.run("leave:m1", call), sf.run("join:m2", call)]);
    expect(call).toHaveBeenCalledTimes(3);
  });
});
