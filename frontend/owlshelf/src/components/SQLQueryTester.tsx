import React, { useState } from "react";

// Define a type for a single row/record retrieved from IndexedDB
interface SqlRow {
  [key: string]: unknown;
}

// Placeholder for actual database interaction logic
interface QueryResult {
  data: SqlRow[];
  error: string | null;
}

async function excuteQuery(sql: string): Promise<QueryResult> {
  console.log("Executing SQL query:", sql);
  await new Promise((resolve) => setTimeout(resolve, 1000)); // Simulate network delay
  if (sql.toLowerCase().includes("error")) {
    return { data: [], error: "Simulated database execution error." };
  }

  // Mock successful result using the defined SqlRow structure
  return {
    data: [{ id: 1, name: "Test Row", status: "active" }],
    error: null,
  };
}

function SQLQueryTester() {
  const [sqlInput, setSqlInput] = useState<string>("");
  // Use QueryResult | undefined initially to prevent rendering empty data before loading
  const [results, setResults] = useState<QueryResult | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sqlInput.trim()) {
      setError("SQL query cannot be empty.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setResults(undefined); // Clear previous results on new submission

    try {
      const result = await excuteQuery(sqlInput);
      setResults(result);
      if (result.error) {
        // We can't rely on result.data here since error is set, but we check defensively
        setError(`Query Error: ${result.error}`);
      } else {
        setError(null);
      }
    } catch (err) {
      console.error("Execution failed:", err);
      setError("An unexpected error occurred during query execution.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ padding: "20px", maxWidth: "800px", margin: "auto" }}>
      <h1 style={{ textAlign: "center" }}>Database SQL Query Tester</h1>
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          marginBottom: "30px",
          borderBottom: "1px solid #ccc",
          paddingBottom: "20px",
        }}
      >
        <label
          htmlFor="sql-input"
          style={{
            marginBottom: "15px",
            fontSize: "1.2rem",
            fontWeight: "bold",
          }}
        >
          Enter SQL Query:
        </label>
        <textarea
          id="sql-input"
          value={sqlInput}
          onChange={(e) => setSqlInput(e.target.value)}
          style={{
            width: "100%",
            height: "200px",
            padding: "15px",
            fontSize: "1rem",
          }}
          placeholder="SELECT * FROM users WHERE id = 1;"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !sqlInput.trim()}
          style={{ marginTop: "20px", padding: "12px 30px", fontSize: "1rem" }}
        >
          {isLoading ? "Running..." : "Execute Query"}
        </button>
      </form>
      {error && (
        <div
          style={{
            color: "#a94442",
            backgroundColor: "#f2ded7",
            border: "1px solid #ebccd1",
            padding: "15px",
            borderRadius: "5px",
            marginBottom: "20px",
          }}
        >
          <strong style={{ marginRight: "10px" }}>Error:</strong> {error}
        </div>
      )}
      {results && results.data.length > 0 && (
        <div style={{ marginTop: "30px" }}>
          <h2 style={{ color: "#337ab7" }}>
            Query Results ({results.data.length} rows)
          </h2>
          <pre
            style={{
              backgroundColor: "#f9f9f9",
              padding: "15px",
              border: "1px solid #ddd",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {JSON.stringify(results.data, null, 2)}
          </pre>
        </div>
      )}
      : results && !error && (
      <div
        style={{
          marginTop: "30px",
          padding: "15px",
          border: "1px solid #ccc",
          borderRadius: "4px",
        }}
      >
        No results found for the given query. Try a different SQL statement.
      </div>
      )
    </div>
  );
}

export default SQLQueryTester;
