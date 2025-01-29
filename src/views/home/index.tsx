import { useUserStore } from "@/hooks/user-store.hook";

const Home = () => {
  const { user } = useUserStore();
  return <div> Welcome {user?.name}</div>;
};

export default Home;
