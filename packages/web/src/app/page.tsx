export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-5xl font-bold mb-4">Find the Human</h1>
      <p className="text-xl text-gray-400 mb-8">Can you fool 5 AIs?</p>
      <button className="bg-primary hover:bg-primary/80 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors">
        Play Now
      </button>
    </main>
  );
}
